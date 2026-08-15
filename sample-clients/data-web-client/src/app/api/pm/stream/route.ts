import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getNatsScoringConnection } from '@/lib/nats';
import protobuf from 'protobufjs';

const PM_PROTO = `
  syntax = "proto3";
  package pm;
  message PmMessage {
    string vin = 1;
    string component = 2;
    int32 health_score = 3;
    string severity = 4;
    map<string, string> evidence = 5;
    string explanation = 6;
    string timestamp = 7;
  }
`;

let _PmMessage: protobuf.Type | null = null;

function getPmMessageType(): protobuf.Type {
  if (!_PmMessage) {
    const root = protobuf.parse(PM_PROTO).root;
    _PmMessage = root.lookupType('pm.PmMessage');
  }
  return _PmMessage;
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  // Local-demo bypass: DEMO_MODE=true (local stack) streams without a
  // session (NextAuth 4 is incompatible with this repo's Next.js 16 runtime,
  // so the demo doesn't depend on it). Production keeps DEMO_MODE unset.
  if (!session && process.env.DEMO_MODE !== 'true') {
    return new Response('Unauthorized', { status: 401 });
  }

  let nc;
  try {
    nc = await getNatsScoringConnection();
  } catch (err) {
    console.error('[/api/pm/stream] NATS connection failed:', err);
    return new Response('Service Unavailable', { status: 503 });
  }

  const PmMessage = getPmMessageType();
  // The detector publishes pm.{VIN}.{component} (battery, 3 tokens) and
  // pm.{VIN}.{component}.{wheel} (tires/brake, 4 tokens), so a single-token
  // wildcard ('pm.*') would never match — '>' matches the full remainder.
  const sub = nc.subscribe('pm.>');

  // Promise that resolves the moment the client disconnects so the start()
  // loop below can stop awaiting the next NATS message and exit. We feed
  // it from BOTH `request.signal.abort` AND the ReadableStream `cancel()`
  // callback so whichever fires first wins. In practice cancel() is the
  // reliable signal in this Next.js + nginx + GKE setup; request.signal
  // is wired in as a cheap belt-and-braces.
  const disconnectController = new AbortController();
  const aborted = new Promise<void>((resolve) => {
    if (disconnectController.signal.aborted) resolve();
    else disconnectController.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  if (request.signal.aborted) disconnectController.abort();
  else request.signal.addEventListener('abort', () => disconnectController.abort(), { once: true });

  const cleanup = () => {
    disconnectController.abort();
    try { sub.unsubscribe(); } catch { /* already gone */ }
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Push an initial comment so nginx (sidecar in front of this pod)
      // flushes the response immediately and switches into streaming mode.
      // Without this, nginx response-buffers the first chunk until a NATS
      // message arrives — and during that buffered window it doesn't
      // notice the client closing its TCP socket, so cancel() never
      // fires. SSE comments (`:` prefix) are ignored by EventSource.
      controller.enqueue(encoder.encode(': connected\n\n'));

      try {
        const iter = sub[Symbol.asyncIterator]();
        // Race the next NATS message against client disconnect. Whichever
        // resolves first wins; if `aborted` wins, we break and run cleanup.
        while (true) {
          const next = await Promise.race([
            iter.next().then((r) => ({ kind: 'msg' as const, result: r })),
            aborted.then(() => ({ kind: 'abort' as const })),
          ]);
          if (next.kind === 'abort') break;
          if (next.result.done) break;
          const msg = next.result.value;
          try {
            // protobufjs toJSON() maps proto fields to camelCase, so the SSE
            // payload carries healthScore (etc.) — parsePmMessage accepts it.
            const decoded = PmMessage.decode(msg.data).toJSON() as Record<string, unknown>;
            // Tires/brake subjects carry a 4th token (pm.{VIN}.{component}.{wheel});
            // battery stays 3-token. Attach it so the client can group per
            // wheel/pad without re-parsing subjects.
            const parts = (msg.subject ?? '').split('.');
            if (parts.length >= 4 && !('wheel' in decoded)) {
              decoded.wheel = parts[3];
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(decoded)}\n\n`));
          } catch (decodeErr: unknown) {
            console.error('[/api/pm/stream] Failed to decode message:', decodeErr);
          }
        }
      } catch (err) {
        console.error('[/api/pm/stream] NATS stream error:', err);
      } finally {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
        console.log('[/api/pm/stream] Stream closed');
      }
    },
    // Fires when the client cancels the response stream (e.g., browser
    // closes the EventSource). Triggers cleanup which aborts the
    // disconnectController and lets the start() loop exit.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Tell nginx (sidecar / ingress) NOT to buffer this response.
      // Without this header nginx will buffer chunks up to its
      // proxy_buffer_size before forwarding them, which delays both the
      // first byte to the client and the propagation of client
      // disconnects back to upstream.
      'X-Accel-Buffering': 'no',
    },
  });
}

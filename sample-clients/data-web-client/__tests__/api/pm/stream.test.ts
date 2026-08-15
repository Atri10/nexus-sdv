import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

const root = protobuf.parse(PM_PROTO).root;
const PmMessage = root.lookupType('pm.PmMessage');

const mockGetServerSession = mock(() => null);
let subStub: {
  [Symbol.asyncIterator]: () => AsyncGenerator<{ data: Uint8Array; subject?: string }>;
  unsubscribe: () => void;
};
const subscribeCalls: string[] = [];

mock.module('next-auth', () => ({
  getServerSession: (args: unknown) => mockGetServerSession(args),
}));
mock.module('@/lib/auth', () => ({ authOptions: {} }));
mock.module('@/lib/nats', () => ({
  getNatsScoringConnection: () =>
    Promise.resolve({
      subscribe: (subject: string) => {
        subscribeCalls.push(subject);
        return subStub;
      },
    }),
}));

const { GET } = await import('@/app/api/pm/stream/route');

function makeAbortableRequest(): Request {
  const controller = new AbortController();
  return new Request('http://localhost/api/pm/stream', { signal: controller.signal });
}

async function* makeMessages(payloads: Uint8Array[]): AsyncGenerator<{ data: Uint8Array; subject?: string }> {
  for (const p of payloads) {
    yield { data: p };
  }
}

function pmPayload(vin: string, component: string, healthScore: number, severity: string): Uint8Array {
  return PmMessage.encode({
    vin,
    component,
    healthScore,
    severity,
    evidence: { ewma_voltage: '12.38' },
    explanation: 'Resting voltage 12.38 V.',
    timestamp: '2026-08-09T00:00:00Z',
  }).finish() as unknown as Uint8Array;
}

describe('GET /api/pm/stream', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    subscribeCalls.length = 0;
  });

  it('subscribes to pm.> so 3-token pm.{VIN}.{component} subjects match', async () => {
    // The detector publishes pm.VIN1001.battery (3 tokens). A 'pm.*' wildcard
    // (exactly one token) would match nothing; the route must subscribe with
    // 'pm.>' (full remainder). This is an integration assertion on the
    // subscription subject — the mocked NATS can't catch the mismatch by
    // itself because it never enforces subject matching.
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    subStub = {
      [Symbol.asyncIterator]: () => makeMessages([]),
      unsubscribe: () => {},
    };
    await GET(makeAbortableRequest());
    expect(subscribeCalls).toContain('pm.>');
    expect(subscribeCalls).not.toContain('pm.*');
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const res = await GET(makeAbortableRequest());
    expect(res.status).toBe(401);
  });

  it('returns SSE response with correct headers when authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    subStub = {
      [Symbol.asyncIterator]: () => makeMessages([]),
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('streams decoded NATS messages as JSON SSE events', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    subStub = {
      [Symbol.asyncIterator]: () =>
        makeMessages([pmPayload('VIN1001', 'battery', 62, 'advisory')]),
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    const text = await res.text();
    expect(text).toContain(
      'data: {"vin":"VIN1001","component":"battery","healthScore":62,"severity":"advisory"',
    );
  });

  it('attaches the 4th subject token as wheel for tires/brake subjects', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    const payload = pmPayload('VIN1001', 'tires', 12, 'critical');
    subStub = {
      // Subject carries pm.{VIN}.{component}.{wheel} — the route must append
      // the 4th token to the emitted JSON.
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return (async function* () {
          if (sent) return;
          sent = true;
          yield { subject: 'pm.VIN1001.tires.fl', data: payload };
        })();
      },
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    const text = await res.text();
    expect(text).toContain('"wheel":"fl"');
  });
});

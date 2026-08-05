import { beforeEach, describe, expect, it, mock } from 'bun:test';
import protobuf from 'protobufjs';

const SCORING_PROTO = `
  syntax = "proto3";
  package scoring;
  message ScoringMessage {
    string vehicle_id = 1;
    string score = 2;
    repeated string suggestions = 3;
  }
`;

const root = protobuf.parse(SCORING_PROTO).root;
const ScoringMessage = root.lookupType('scoring.ScoringMessage');

const mockGetServerSession = mock(() => null);
let subStub: {
  [Symbol.asyncIterator]: () => AsyncGenerator<{ data: Uint8Array }>;
  unsubscribe: () => void;
};

mock.module('next-auth', () => ({
  getServerSession: (args: unknown) => mockGetServerSession(args),
}));
mock.module('@/lib/auth', () => ({ authOptions: {} }));
mock.module('@/lib/nats', () => ({
  getNatsScoringConnection: () =>
    Promise.resolve({ subscribe: () => subStub }),
}));

const { GET } = await import('@/app/api/scoring/stream/route');

function makeAbortableRequest(): Request {
  const controller = new AbortController();
  return new Request('http://localhost/api/scoring/stream', { signal: controller.signal });
}

async function* makeMessages(payloads: Uint8Array[]): AsyncGenerator<{ data: Uint8Array }> {
  for (const p of payloads) {
    yield { data: p };
  }
}

function scoringPayload(vehicleId: string, score: string, suggestions: string[]): Uint8Array {
  return ScoringMessage.encode({ vehicleId, score, suggestions }).finish() as unknown as Uint8Array;
}

describe('GET /api/scoring/stream', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
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
        makeMessages([scoringPayload('VIN123', '8.5', ['a', 'b'])]),
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    const text = await res.text();
    expect(text).toContain('data: {"vehicle":"VIN123","score":"8.5","message":"a, b"}\n\n');
  });
});

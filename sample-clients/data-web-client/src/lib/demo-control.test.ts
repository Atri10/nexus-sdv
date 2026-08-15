import { describe, expect, it, mock } from 'bun:test';
import { StringCodec } from 'nats';

const sc = StringCodec();

const REPLY = { vin: 'VIN1001', running: true, published: 3, messageType: 'demo' };

const captured: Array<{ subject: string; payload: string; timeout: number }> = [];
const fakeRequest = mock(async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
  captured.push({ subject, payload: sc.decode(payload), timeout: opts.timeout });
  return { data: sc.encode(JSON.stringify(REPLY)) };
});

mock.module('@/lib/nats', () => ({
  getNatsScoringConnection: async () => ({ request: fakeRequest }),
}));

const { demoControl, DemoSimulatorOfflineError, discoverSimulator } = await import('@/lib/demo-control');

describe('demoControl', () => {
  it('requests commands.<vin>.demo with { action, vin } JSON and returns the parsed reply', async () => {
    const reply = await demoControl('start', 'VIN1001');

    expect(captured).toHaveLength(1);
    expect(captured[0].subject).toBe('commands.VIN1001.demo');
    // The VIN is carried in the body (not just the subject) so the
    // simulator's control handler can adopt it on start (runtime VIN
    // switching).
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'start', vin: 'VIN1001' });
    expect(captured[0].timeout).toBe(3000);
    expect(reply).toEqual(REPLY);
  });

  it('throws DemoSimulatorOfflineError when the simulator does not answer (request timeout)', async () => {
    fakeRequest.mockImplementationOnce(async () => {
      throw new Error('NatsTimeoutError: no responders available for request');
    });

    await expect(demoControl('status', 'VIN1001')).rejects.toBeInstanceOf(DemoSimulatorOfflineError);
  });
});

describe('discoverSimulator', () => {
  it('returns the first pool VIN that answers a status request', async () => {
    captured.length = 0;
    fakeRequest.mockImplementation(async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      captured.push({ subject, payload: sc.decode(payload), timeout: opts.timeout });
      if (subject === 'commands.VIN1005.demo') {
        return { data: sc.encode(JSON.stringify({ ...REPLY, vin: 'VIN1005' })) };
      }
      throw new Error('NatsTimeoutError');
    });

    const found = await discoverSimulator(['VIN1001', 'VIN1002', 'VIN1005']);

    expect(found).toBe('VIN1005');
    expect(captured.map((c) => c.subject)).toEqual([
      'commands.VIN1001.demo',
      'commands.VIN1002.demo',
      'commands.VIN1005.demo',
    ]);
    expect(captured.every((c) => c.timeout === 500)).toBe(true);
    expect(captured.every((c) => JSON.parse(c.payload).action === 'status')).toBe(true);
  });

  it('returns null when no pool VIN answers', async () => {
    captured.length = 0;
    fakeRequest.mockImplementation(async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      captured.push({ subject, payload: sc.decode(payload), timeout: opts.timeout });
      throw new Error('NatsTimeoutError');
    });

    const found = await discoverSimulator(['VIN1001', 'VIN1002']);

    expect(found).toBeNull();
  });

  it('returns null for an empty pool', async () => {
    expect(await discoverSimulator([])).toBeNull();
  });

  it('skips malformed replies and keeps scanning', async () => {
    captured.length = 0;
    fakeRequest.mockImplementation(async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      captured.push({ subject, payload: sc.decode(payload), timeout: opts.timeout });
      if (subject === 'commands.VIN1001.demo') {
        return { data: sc.encode('not-json') };
      }
      return { data: sc.encode(JSON.stringify({ ...REPLY, vin: 'VIN1002' })) };
    });

    const found = await discoverSimulator(['VIN1001', 'VIN1002']);

    expect(found).toBe('VIN1002');
  });
});

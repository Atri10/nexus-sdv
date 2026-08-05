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

const { demoControl, DemoSimulatorOfflineError } = await import('@/lib/demo-control');

describe('demoControl', () => {
  it('requests commands.<vin>.demo with { action } JSON and returns the parsed reply', async () => {
    const reply = await demoControl('start', 'VIN1001');

    expect(captured).toHaveLength(1);
    expect(captured[0].subject).toBe('commands.VIN1001.demo');
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'start' });
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

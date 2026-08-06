import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StringCodec } from 'nats';

const sc = StringCodec();

const REPLY = {
  vin: 'VIN1001',
  running: true,
  published: 3,
  messageType: 'both',
  components: [
    { id: 'battery', label: 'Battery', enabled: true, sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }] },
  ],
};

const captured: Array<{ subject: string; payload: string; timeout: number }> = [];
const fakeRequest = jest.fn(async (_subject: string, payload: Uint8Array, opts: { timeout: number }) => {
  captured.push({ subject: _subject, payload: sc.decode(payload), timeout: opts.timeout });
  return { data: sc.encode(JSON.stringify(REPLY)) };
});

jest.mock('@/lib/nats', () => ({
  getNatsScoringConnection: jest.fn(async () => ({ request: fakeRequest })),
}));

import { demoControl } from '@/lib/demo-control';

beforeEach(() => {
  captured.length = 0;
  fakeRequest.mockClear();
});

describe('demoControl per-component', () => {
  it('sends { action, component } JSON when a component is given', async () => {
    const reply = await demoControl('start', 'VIN1001', 'battery');
    expect(captured[0].subject).toBe('commands.VIN1001.demo');
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'start', component: 'battery' });
    expect(captured[0].timeout).toBe(3000);
    expect(reply.components?.[0]?.sensors[0]?.unit).toBe('V');
  });

  it('omits the component field when none is given (legacy behavior)', async () => {
    await demoControl('stop', 'VIN1001');
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'stop' });
  });

  it('throws DemoSimulatorOfflineError when the request times out', async () => {
    fakeRequest.mockImplementationOnce(async () => {
      throw new Error('timeout');
    });
    await expect(demoControl('status', 'VIN1001')).rejects.toThrow('Simulator did not respond');
  });
});

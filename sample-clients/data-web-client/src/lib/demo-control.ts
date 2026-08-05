import { getNatsScoringConnection } from '@/lib/nats';
import { StringCodec } from 'nats';

export type DemoAction = 'start' | 'stop' | 'status';

export interface DemoControlReply {
  vin: string;
  running: boolean;
  published: number;
  messageType: string;
  error?: string;
}

export class DemoSimulatorOfflineError extends Error {
  constructor() {
    super('Simulator did not respond — is the stack up and the simulator registered?');
    this.name = 'DemoSimulatorOfflineError';
  }
}

const sc = StringCodec();

export async function demoControl(action: DemoAction, vin: string): Promise<DemoControlReply> {
  const nc = await getNatsScoringConnection();
  let reply;
  try {
    // nats.js rejects on timeout (NatsTimeoutError) — map to a clear error.
    reply = await nc.request(
      `commands.${vin}.demo`,
      sc.encode(JSON.stringify({ action })),
      { timeout: 3000 }
    );
  } catch {
    throw new DemoSimulatorOfflineError();
  }
  return JSON.parse(sc.decode(reply.data)) as DemoControlReply;
}

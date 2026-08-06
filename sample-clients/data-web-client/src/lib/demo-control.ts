import { getNatsScoringConnection } from '@/lib/nats';
import { StringCodec } from 'nats';

export type DemoAction = 'start' | 'stop' | 'status';

/** One publishable signal of a component (unit empty when plain). */
export interface SignalInfo {
  name: string;
  label: string;
  unit?: string;
}

/** One independently controllable telemetry component, discovered from the
 * simulator's status reply. */
export interface ComponentStatus {
  id: string;
  label: string;
  enabled: boolean;
  sensors: SignalInfo[];
}

export interface DemoControlReply {
  vin: string;
  running: boolean;
  published: number;
  messageType: string;
  components?: ComponentStatus[];
  error?: string;
}

export class DemoSimulatorOfflineError extends Error {
  constructor() {
    super('Simulator did not respond — is the stack up and the simulator registered?');
    this.name = 'DemoSimulatorOfflineError';
  }
}

const sc = StringCodec();

export async function demoControl(action: DemoAction, vin: string, component?: string): Promise<DemoControlReply> {
  const nc = await getNatsScoringConnection();
  let reply;
  try {
    // nats.js rejects on timeout (NatsTimeoutError) — map to a clear error.
    reply = await nc.request(
      `commands.${vin}.demo`,
      sc.encode(JSON.stringify(component ? { action, component } : { action })),
      { timeout: 3000 }
    );
  } catch {
    throw new DemoSimulatorOfflineError();
  }
  return JSON.parse(sc.decode(reply.data)) as DemoControlReply;
}

/**
 * Find the running simulator by probing every pool VIN in parallel with a
 * short timeout (500ms each, all at once — worst case ~500ms total). Returns
 * the first VIN that answers a status request without an error, or null when
 * no simulator is reachable.
 */
export async function discoverSimulator(pool: string[]): Promise<string | null> {
  if (pool.length === 0) return null;
  const nc = await getNatsScoringConnection();
  const results = await Promise.allSettled(
    pool.map(async (vin) => {
      const reply = await nc.request(
        `commands.${vin}.demo`,
        sc.encode(JSON.stringify({ action: 'status' })),
        { timeout: 500 }
      );
      return { vin, reply };
    })
  );
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    try {
      const parsed = JSON.parse(sc.decode(result.value.reply.data)) as DemoControlReply;
      if (!parsed.error) return result.value.vin;
    } catch {
      // Malformed reply — keep scanning the rest of the pool.
    }
  }
  return null;
}

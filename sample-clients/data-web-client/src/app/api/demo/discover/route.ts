import { NextResponse } from 'next/server';
import { discoverSimulator } from '@/lib/demo-control';

/** Space/comma separated VIN pool configured via VIN_POOL (see local-dev). */
const VIN_POOL = (process.env.VIN_POOL ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Find the running simulator's VIN by probing the pool over NATS (server-side
 * only — the nats client must never enter the browser bundle). Returns the
 * VIN and its running state so consumers (fleet/device badges) never show a
 * stale one-shot.
 */
export async function GET() {
  try {
    const vin = await discoverSimulator(VIN_POOL);
    if (!vin) return NextResponse.json({ vin: null, running: false });
    // Confirm liveness + running state with a status round-trip; the reply's
    // own vin is the sim's actual identity (it answers every pool VIN via
    // the commands.> wildcard, so the probed VIN is not authoritative).
    const { demoControl } = await import('@/lib/demo-control');
    const reply = await demoControl('status', vin).catch(() => null);
    return NextResponse.json({
      vin: reply?.vin || vin,
      running: reply?.running === true,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'simulator discovery failed' },
      { status: 503 }
    );
  }
}

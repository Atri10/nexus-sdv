import { NextResponse } from 'next/server';
import { discoverSimulator } from '@/lib/demo-control';

/** Space/comma separated VIN pool configured via VIN_POOL (see local-dev). */
const VIN_POOL = (process.env.VIN_POOL ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Find the running simulator's VIN by probing the pool over NATS (server-side
 * only — the nats client must never enter the browser bundle).
 */
export async function GET() {
  try {
    const vin = await discoverSimulator(VIN_POOL);
    return NextResponse.json({ vin });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'simulator discovery failed' },
      { status: 503 }
    );
  }
}

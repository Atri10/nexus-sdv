import { NextResponse } from 'next/server';

const CHART_SERVICE = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:8081';

/** Space/comma separated VIN pool configured via VIN_POOL (see local-dev). */
const VIN_POOL = (process.env.VIN_POOL ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

export async function GET() {
  try {
    const res = await fetch(`${CHART_SERVICE}/api/v1/vehicles`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vehicles = (await res.json()) as string[];
    return NextResponse.json({ vehicles, pool: VIN_POOL });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'chart service unreachable' },
      { status: 503 }
    );
  }
}

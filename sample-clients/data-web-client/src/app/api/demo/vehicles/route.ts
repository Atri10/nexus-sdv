import { NextResponse } from 'next/server';

const CHART_SERVICE = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:8081';

export async function GET() {
  try {
    const res = await fetch(`${CHART_SERVICE}/api/v1/vehicles`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vehicles = (await res.json()) as string[];
    return NextResponse.json({ vehicles });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'chart service unreachable' },
      { status: 503 }
    );
  }
}

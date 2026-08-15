import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { VIN_POOL } from '@/components/demo/demo-control-bar';
import { demoControl, type DemoAction } from '@/lib/demo-control';

// Only pool VINs are controllable — anything else is rejected up front so an
// attacker can't inject NATS subject tokens ('.' / '>' / '*' would change
// commands.{vin}.demo into another subject).
const POOL_MEMBERSHIP: Record<string, true> = Object.fromEntries(VIN_POOL.map((v) => [v, true]));

export async function POST(request: Request) {
  let body: { action?: unknown; vin?: unknown; component?: unknown; preset?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { action, vin, component, preset } = body ?? {};
  if (
    typeof action !== 'string' ||
    !['start', 'stop', 'status', 'speed', 'reset'].includes(action) ||
    typeof vin !== 'string' ||
    !vin
  ) {
    return NextResponse.json(
      { error: 'expected { action: start|stop|status|speed|reset, vin: string, component?: string, preset?: string }' },
      { status: 400 }
    );
  }
  // Authz parity with the devices routes: session required in production,
  // DEMO_MODE bypass for the local stack. This is a simulator CONTROL
  // endpoint — never leave it open in production.
  const session = await getServerSession(authOptions);
  if (!session && process.env.DEMO_MODE !== 'true') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!POOL_MEMBERSHIP[vin]) {
    return NextResponse.json(
      { error: `vin must be one of the demo pool VINs (${VIN_POOL.join(', ')})` },
      { status: 400 }
    );
  }
  try {
    const reply = await demoControl(
      action as DemoAction,
      vin,
      typeof component === 'string' && component ? component : undefined,
      typeof preset === 'string' && preset ? preset : undefined
    );
    if (reply.error) return NextResponse.json(reply, { status: 400 });
    return NextResponse.json(reply);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'simulator offline' },
      { status: 503 }
    );
  }
}

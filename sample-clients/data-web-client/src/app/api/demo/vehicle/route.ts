import { NextResponse } from 'next/server';
import { demoControl, type DemoAction } from '@/lib/demo-control';

export async function POST(request: Request) {
  let body: { action?: unknown; vin?: unknown; component?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { action, vin, component } = body ?? {};
  if (
    typeof action !== 'string' ||
    !['start', 'stop', 'status'].includes(action) ||
    typeof vin !== 'string' ||
    !vin
  ) {
    return NextResponse.json(
      { error: 'expected { action: start|stop|status, vin: string, component?: string }' },
      { status: 400 }
    );
  }
  try {
    const reply = await demoControl(
      action as DemoAction,
      vin,
      typeof component === 'string' && component ? component : undefined
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

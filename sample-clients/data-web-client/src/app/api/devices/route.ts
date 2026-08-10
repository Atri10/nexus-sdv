import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getDevices } from '@/lib/devices';
import { getAllowedVehicleIds } from '@/lib/acl';

export async function GET() {
  const session = await getServerSession(authOptions);

  // Local-demo bypass: when DEMO_MODE=true (local stack), allow fleet access
  // without a Keycloak session. NextAuth 4 is incompatible with this repo's
  // Next.js 16 runtime (the OAuth flow fails with a generic error), so the
  // local demo doesn't depend on it. Production deployments keep DEMO_MODE
  // unset and require a real session.
  if (!session && process.env.DEMO_MODE === 'true') {
    // getDevices() with no arg = key-scan all devices (ACL path with [] would
    // return none).
    const devices = await getDevices();
    return NextResponse.json({ devices });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allowedIds = await getAllowedVehicleIds(session.groups);
    const devices = await getDevices(allowedIds);
    return NextResponse.json({ devices });
  } catch (err) {
    console.error('[/api/devices]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getAllowedVehicleIds } from '@/lib/acl';

// Proxy to Java telemetry-chart-service
const TELEMETRY_SERVICE_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:8081';

// Demo VINs are pool-style (VIN1001..VIN1010); the platform's real VINs are
// 17-char ISO 3779. Accept either, but strictly: the guard exists to block
// URL-path injection into the proxied fetch (encoded traversal segments,
// extra path/query fragments) — anything not matching is rejected with 400.
const VIN_RE = /^(?:VIN\d{4}|[A-HJ-NPR-Z0-9]{17})$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const { vin } = await params;
  const { searchParams } = new URL(request.url);

  // Authz parity with /api/devices/[id]: session required in production
  // (DEMO_MODE bypass for the local stack where NextAuth is incompatible),
  // plus the vehicle ACL — never serve raw telemetry for a VIN the user
  // isn't allowed to see. In DEMO_MODE the ACL is skipped entirely: the
  // demo must show every VIN (the sim + backfill populate VIN1001-1010),
  // and with DB_NAME unset the fail-closed ACL returns [] which would 404
  // every vehicle.
  const session = await getServerSession(authOptions);
  if (!session && process.env.DEMO_MODE !== 'true') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.DEMO_MODE !== 'true') {
    const allowed = await getAllowedVehicleIds(session?.groups ?? []);
    if (allowed !== undefined && !allowed.includes(vin)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }
  if (!VIN_RE.test(vin)) {
    return NextResponse.json(
      { error: `invalid VIN: must be 17 uppercase alphanumeric characters` },
      { status: 400 }
    );
  }

  // Build query parameters
  const queryParams = new URLSearchParams();
  if (searchParams.has('start')) queryParams.set('start', searchParams.get('start')!);
  if (searchParams.has('end')) queryParams.set('end', searchParams.get('end')!);
  if (searchParams.has('columns')) queryParams.set('columns', searchParams.get('columns')!);
  if (searchParams.has('limit')) queryParams.set('limit', searchParams.get('limit')!);

  try {
    const response = await fetch(`${TELEMETRY_SERVICE_URL}/api/v1/vehicles/${vin}/telemetry?${queryParams.toString()}`, {
      headers: {
        'Accept': 'application/json',
      },
      // Add timeout
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `Telemetry service error: ${response.status} ${error}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Transform Java service response to frontend format
    // Java returns: [{ timestamp: string, values: { col: string } }]
    // Frontend expects: { rows: TimeSeriesRow[], columns: string[], nextCursor?: string }
    
    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ rows: [], columns: [], nextCursor: null });
    }

    // Collect ALL columns from ALL rows (different rows may have different columns)
    const columns = Array.from(new Set(data.flatMap((row: { values?: Record<string, string> }) => Object.keys(row.values || {}))));

    // Transform rows - keep values as strings for DeviceDetailResponse
    const rows = data.map((row: { timestamp: string; values: Record<string, string> }) => ({
      timestamp: row.timestamp,
      values: row.values || {},
    }));

    return NextResponse.json({
      rows,
      columns,
      nextCursor: null,
    });
  } catch (error) {
    console.error('Telemetry proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch telemetry data' },
      { status: 502 }
    );
  }
}
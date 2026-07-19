import { NextRequest, NextResponse } from 'next/server';

// Proxy to Java telemetry-chart-service
const TELEMETRY_SERVICE_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:8081';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const { vin } = await params;
  const { searchParams } = new URL(request.url);

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
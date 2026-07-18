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
    return NextResponse.json(data);
  } catch (error) {
    console.error('Telemetry proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch telemetry data' },
      { status: 502 }
    );
  }
}

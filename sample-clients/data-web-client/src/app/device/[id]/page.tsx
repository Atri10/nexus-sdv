'use client';
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AppLayout from '@/components/app-layout';
import DataTable from '@/components/data-table';
import TimeRangeSelector from '@/components/time-range-selector';
import type { TimeRange } from '@/types/telemetry';
import { extractGpsPoints } from '@/lib/gps';
import GpsTrackMap from '@/components/gps-track-map';
import TelemetryChart from '@/components/telemetry-chart';

interface MapsConfig {
  apiKey: string;
  mapId: string;
}

export default function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [range, setRange] = useState<'1h' | '6h' | '24h' | '7d'>('1h');
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ deviceId: string; rows: { timestamp: string; values: Record<string, number> }[]; columns: string[]; nextCursor?: string | null } | null>(null);
  const [mapsConfig, setMapsConfig] = useState<{ apiKey: string; mapId: string } | null>(null);

  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [columns, setColumns] = useState<string[]>([]);

  const [chartColumns, setChartColumns] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/maps-config')
      .then((r) => r.json() as Promise<{ apiKey: string; mapId: string }>)
      .then(setMapsConfig)
      .catch(() => { /* maps config unavailable */ });
  }, []);

  const fetchPage = useCallback((cursor: string | null, size: number, currentRange: '1h' | '6h' | '24h' | '7d') => {
    setLoading(true);
    setError(null);
    const url = new URL(`/api/telemetry/${id}`, window.location.origin);
    const end = new Date();
    const start = new Date(end.getTime() - parseTimeRange(currentRange));
    url.searchParams.set('start', start.toISOString());
    url.searchParams.set('end', end.toISOString());
    url.searchParams.set('limit', String(size));
    if (cursor) url.searchParams.set('cursor', cursor);

    fetch(url.toString())
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { rows: { timestamp: string; values: Record<string, string> }[]; columns: string[]; nextCursor?: string | null }) => {
        // Convert string values to numbers for charting
        const rows = data.rows.map((row) => {
          const values: Record<string, number> = {};
          for (const [k, v] of Object.entries(row.values)) {
            values[k] = parseFloat(v);
          }
          return {
            timestamp: row.timestamp,
            values,
          };
        });
        setDetail({ deviceId: id, rows, columns: data.columns, nextCursor: data.nextCursor });
        // Merge new columns into the known set so header is stable across pages
        setColumns((prev) => {
          const merged = new Set([...prev, ...data.columns]);
          return Array.from(merged);
        });
        // Auto-detect numeric columns for charting (check ALL rows, not just first)
        const numericCols = data.columns.filter((col) => {
          return data.rows.some((row) => {
            const val = row.values[col];
            return val !== undefined && !isNaN(parseFloat(val));
          });
        });
        if (numericCols.length > 0) {
          setChartColumns(numericCols);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [id]);

  // Helper to parse TimeRange string to milliseconds
  function parseTimeRange(range: '1h' | '6h' | '24h' | '7d'): number {
    switch (range) {
      case '1h': return 60 * 60 * 1000;
      case '6h': return 6 * 60 * 60 * 1000;
      case '24h': return 24 * 60 * 60 * 1000;
      case '7d': return 7 * 24 * 60 * 60 * 1000;
      default: return 60 * 60 * 1000;
    }
  }

  // Reset on range or pageSize change
  useEffect(() => {
    setCursorStack([null]);
    setPageIndex(0);
    setColumns([]);
    fetchPage(null, pageSize, range);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range]);

  // Auto-refresh every 30 seconds, but only when the user is viewing the
  // first (newest) page. Refreshing while paginated to an older page would
  // shift the user's view as new rows arrive at the top, so we pause the
  // timer for pageIndex > 0.
  useEffect(() => {
    if (pageIndex !== 0) return;
    const intervalId = setInterval(() => {
      fetchPage(null, pageSize, range);
    }, 30_000);
    return () => clearInterval(intervalId);
  }, [pageIndex, pageSize, range, fetchPage]);

  function handleNext() {
    if (!detail?.nextCursor) return;
    const nextCursor = detail.nextCursor;
    const newStack = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    setCursorStack(newStack);
    setPageIndex(pageIndex + 1);
    fetchPage(nextCursor, pageSize, range);
  }

  function handlePrev() {
    if (pageIndex === 0) return;
    const newIndex = pageIndex - 1;
    setPageIndex(newIndex);
    fetchPage(cursorStack[newIndex] ?? null, pageSize, range);
  }

  function handlePageSizeChange(size: number) {
    setPageSize(size);
    setCursorStack([null]);
    setPageIndex(0);
    setColumns([]);
    fetchPage(null, size, range);
  }

  const tableColumnKeys = ['timestamp', ...columns];

  const tableData = (detail?.rows ?? []).map((row) => ({
    timestamp: new Date(row.timestamp).toLocaleString(),
    ...row.values,
  }));

  const gpsPoints = detail ? extractGpsPoints(detail) : [];

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-sm text-gray-500">
          <Link href="/fleet" className="hover:text-gray-900">
            Fleet
          </Link>
          <span className="mx-2">\u203A</span>
          <span className="text-gray-900">{id}</span>
        </nav>

        {/* Header row */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">{id}</h1>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        {error && <p className="text-red-500">Error: {error}</p>}

        {(loading || detail) && (
          <div className="space-y-4">
            {/* Live Telemetry Chart */}
            {chartColumns.length > 0 && (
              <TelemetryChart
                vehicleId={id}
                columns={chartColumns}
              />
            )}

            {/* Data Table */}
            <DataTable
              columnKeys={tableColumnKeys}
              data={tableData}
              serverPagination={{
                pageIndex,
                pageSize,
                hasMore: detail?.nextCursor ? true : false,
                loading,
                onNext: handleNext,
                onPrev: handlePrev,
                onPageSizeChange: handlePageSizeChange,
              }}
            />

            {/* GPS Track Map */}
            {!loading && gpsPoints.length > 0 && mapsConfig?.apiKey && (
              <GpsTrackMap points={gpsPoints} apiKey={mapsConfig.apiKey} mapId={mapsConfig.mapId} />
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
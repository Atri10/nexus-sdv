'use client';
import { use, useEffect, useState } from 'react';
import nextDynamic from 'next/dynamic';
import AppLayout from '@/components/app-layout';
import DataTable from '@/components/data-table';
import TimeRangeSelector from '@/components/time-range-selector';
import type { TimeRange } from '@/types/telemetry';
import { extractGpsPoints } from '@/lib/gps';
import { ChartControls } from '@/components/chart-controls';
import { LatestStats } from '@/components/latest-stats';
import { StateView } from '@/components/state-view';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { buildTableRows } from '@/lib/telemetry-table';
import { unitsForSeries } from '@/lib/telemetry-chart-utils';
import type { DeviceDetailResponse } from '@/types/telemetry';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { FadeIn } from '@/components/motion/fade-in';
import { COMPONENT_ZONES, seriesForComponent } from '@/lib/vehicle-components';
import { useSimulatorState } from '@/hooks/use-simulator-state';

// Heavy client-only components (Google Maps, three.js, Chart.js + zoom all
// touch browser APIs at module scope; SSR must never evaluate them).
const GpsTrackMap = nextDynamic(() => import('@/components/gps-track-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[400px] w-full items-center justify-center rounded border border-border">
      <p className="text-sm text-muted-foreground">Loading map…</p>
    </div>
  ),
});
const DeviceScene = nextDynamic(() => import('@/components/scene/device-scene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[380px] w-full items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading scene…</p>
    </div>
  ),
});
const TelemetryChart = nextDynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[400px] w-full items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading chart…</p>
    </div>
  ),
});

// Live vehicle detail: never statically prerender (live telemetry +
// demo-mode session bypass must resolve at request time, not build time).
export const dynamic = 'force-dynamic';

// Concrete hex for the scene's body paint — matches the shell --primary cyan
// (dark mode); three.js materials need a literal color, not the CSS variable.
const SCENE_PRIMARY = '#38bdf8';

const CHIP_BASE =
  'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const CHIP_ACTIVE =
  'border-cyan-400/60 bg-cyan-400/10 text-cyan-700 shadow-[0_0_10px_rgba(34,211,238,0.25)] dark:text-cyan-300';
const CHIP_IDLE = 'border-border/70 bg-card/50 text-muted-foreground hover:bg-muted hover:text-foreground';

export default function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [range, setRange] = useState<TimeRange>('1h');
  const [type, setType] = useState<'line' | 'area' | 'bar'>('line');
  const [axisMode, setAxisMode] = useState<'single' | 'dual'>('single');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [compareVins, setCompareVins] = useState<string[]>([]);
  const [resetZoomToken, setResetZoomToken] = useState(0);
  const [mapsConfig, setMapsConfig] = useState<{ apiKey: string; mapId: string } | null>(null);
  // 'all' keeps the chart unfiltered; a zone click or chip selects a component.
  const [componentId, setComponentId] = useState<string>('all');
  // Shared simulator state — live across all pages (no stale one-shots).
  const sim = useSimulatorState();
  const simVin = sim.vin;
  const simRunning = sim.running;
  const isSim = simVin === id;

  const theme = useChartTheme();
  const { series, loading, error, refetch } = useTelemetryData({ vin: id, range, compareVins });

  useEffect(() => {
    fetch('/api/maps-config')
      .then((r) => r.json() as Promise<{ apiKey: string; mapId: string }>)
      .then(setMapsConfig)
      .catch(() => { /* maps config unavailable */ });
  }, []);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(key)) {
        n.delete(key);
      } else {
        n.add(key);
      }
      return n;
    });

  // Component filter: 'all' keeps every series; a zone/chip selection narrows
  // the chart to that component's sensors. Table/GPS/KPI stay on all series.
  const chartSeries = componentId === 'all' ? series : seriesForComponent(series, componentId);
  const stateView = error ? 'error' : loading ? 'loading' : chartSeries.length === 0 ? 'empty' : 'ready';

  // One column per series (unique key), display label without the VIN prefix
  // for the primary vehicle and "VIN · label" for compare vehicles.
  const columnKeys = series.map((s) =>
    s.vin === id ? s.label : `${s.vin} · ${s.label}`
  );
  const tableColumnKeys = ['timestamp', ...columnKeys];

  // Join by timestamp — never by array index — so live-appended and
  // compare-VIN series stay aligned (see lib/telemetry-table).
  const tableRows = buildTableRows(series);
  const tableData = tableRows.map((r) => ({
    timestamp: new Date(r.tsKey).toLocaleString(),
    ...Object.fromEntries(
      series.map((s) => {
        const display = s.vin === id ? s.label : `${s.vin} · ${s.label}`;
        const v = r.values[s.key];
        return [display, v ?? '—'];
      })
    ),
  }));

  // GPS extraction uses raw column names (not series keys) with ISO timestamps.
  const gpsColumns = series.map((s) => s.column);
  const gpsRows: DeviceDetailResponse['rows'] = tableRows.map((r) => ({
    timestamp: r.iso,
    // Omit absent cells — extractGpsPoints skips rows without lat/lng anyway.
    values: Object.fromEntries(
      series.flatMap((s) => {
        const v = r.values[s.key];
        return v == null ? [] : [[s.column, v] as const];
      })
    ) as Record<string, string | number>,
  }));
  const gpsPoints = extractGpsPoints({
    deviceId: id,
    columns: gpsColumns,
    rows: gpsRows,
  });

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Vehicle {id}</h1>
            <Badge variant={error ? 'destructive' : 'default'} className="gap-1.5">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {!error && (
                  <span className={`live-ping absolute inline-flex h-full w-full rounded-full ${loading ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${error ? 'bg-destructive' : loading ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              </span>
              {error ? 'Error' : loading ? 'Loading' : 'Data'}
            </Badge>
            {isSim && (
              <Badge
                variant={simRunning ? 'default' : 'outline'}
                className="gap-1.5 border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
              >
                <span className={`h-2 w-2 rounded-full ${simRunning ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'}`} />
                {simRunning ? 'SIM RUNNING' : 'SIM STOPPED'}
              </Badge>
            )}
            {!isSim && simVin && (
              <span className="font-mono text-xs text-muted-foreground">
                sim is {simVin}
              </span>
            )}
          </div>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        <ChartControls
          type={type} onTypeChange={setType}
          series={chartSeries} hidden={hidden} onToggle={toggle}
          axisMode={axisMode} onAxisModeChange={setAxisMode}
          onResetZoom={() => setResetZoomToken((t) => t + 1)}
          onAddCompare={(v) => setCompareVins((c) => c.includes(v) ? c : [...c, v])}
          compareVins={compareVins}
        />

        {series.length > 0 && (
          <FadeIn>
            <LatestStats series={series} hidden={hidden} />
          </FadeIn>
        )}

        {/* 3D scene: click a zone (or chip) to filter the chart by component. */}
        <FadeIn>
          <section className="overflow-hidden rounded-lg border border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <h2 className="text-base font-semibold tracking-wide text-foreground">
                Vehicle scene
              </h2>
              <span className="font-mono text-xs text-muted-foreground">
                DRAG TO ORBIT · SCROLL TO ZOOM · CLICK A ZONE TO FILTER
              </span>
            </div>
            <div className="relative h-[380px]">
              <DeviceScene componentId={componentId} onSelect={setComponentId} color={SCENE_PRIMARY} animate />
            </div>
            {/* Keyboard/accessible component selector — mirrors zone clicks. */}
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
              <button
                type="button"
                aria-pressed={componentId === 'all'}
                onClick={() => setComponentId('all')}
                className={`${CHIP_BASE} ${componentId === 'all' ? CHIP_ACTIVE : CHIP_IDLE}`}
              >
                All
              </button>
              {COMPONENT_ZONES.map((zone) => (
                <button
                  key={zone.id}
                  type="button"
                  aria-pressed={componentId === zone.id}
                  onClick={() => setComponentId(zone.id)}
                  className={`${CHIP_BASE} ${componentId === zone.id ? CHIP_ACTIVE : CHIP_IDLE}`}
                >
                  <span className="h-3 w-3 shrink-0 rounded" style={{ backgroundColor: zone.color }} />
                  {zone.label}
                </button>
              ))}
            </div>
          </section>
        </FadeIn>

        <FadeIn>
          <Card>
            <CardHeader><CardTitle>Telemetry</CardTitle></CardHeader>
            <CardContent>
              <StateView state={stateView} onRetry={refetch}>
                <TelemetryChart vehicleId={id} series={chartSeries} type={type} axisMode={axisMode} hidden={hidden} theme={theme} resetZoomToken={resetZoomToken} units={unitsForSeries(chartSeries)} />
              </StateView>
            </CardContent>
          </Card>
        </FadeIn>

        <Tabs defaultValue="table">
          <TabsList>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="map">Map</TabsTrigger>
          </TabsList>
          <TabsContent value="table">
            <DataTable columnKeys={tableColumnKeys} data={tableData} />
          </TabsContent>
          <TabsContent value="map">
            <GpsTrackMap points={gpsPoints} apiKey={mapsConfig?.apiKey ?? ''} mapId={mapsConfig?.mapId} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

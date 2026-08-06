'use client';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import AppLayout from '@/components/app-layout';
import TimeRangeSelector from '@/components/time-range-selector';
import { LatestStats } from '@/components/latest-stats';
import { StateView } from '@/components/state-view';
import { Skeleton } from '@/components/ui/skeleton';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { DEMO_COMPONENTS, seriesForComponent } from '@/lib/vehicle-components';
import { DataPath } from '@/components/demo/data-path';
import { DemoControlBar, VIN_POOL, type DemoStatus } from '@/components/demo/demo-control-bar';
import { VehicleSchematic } from '@/components/demo/vehicle-schematic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TimeRange } from '@/types/telemetry';

// chart.js's zoom plugin pulls in hammerjs, which touches `document` at module
// scope — not SSR-safe. Load the chart client-only (this page is statically
// prerendered, unlike the dynamic /device routes).
const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[400px] w-full rounded-lg" />,
});

/** Random pool VIN, never the same as the current one. */
function randomVin(exclude?: string): string {
  const pool = VIN_POOL.filter((v) => v !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] ?? VIN_POOL[0];
}

/**
 * Interactive /demo page: control bar (vehicle + simulator start/stop), the
 * vehicle schematic with clickable component nodes, the animated NATS→Bigtable
 * data path and a telemetry chart filtered to the active component's sensors.
 */
export default function DemoPage({ searchParams }: { searchParams: Promise<{ vin?: string }> }) {
  const { vin: urlVin } = use(searchParams);
  const [vin, setVin] = useState<string>(urlVin ?? VIN_POOL[0]);
  const [componentId, setComponentId] = useState<string>('battery');
  const [range, setRange] = useState<TimeRange>('1h');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulatorVin, setSimulatorVin] = useState<string | null>(null);
  const userPicked = useRef(false);

  const theme = useChartTheme();
  const { series, loading, error, refetch } = useTelemetryData({ vin, range });

  // No ?vin= given: randomize the default vehicle client-side (after the
  // deterministic first paint so SSR and hydration agree).
  useEffect(() => {
    if (urlVin) return;
    const t = window.setTimeout(() => setVin((prev) => randomVin(prev)), 0);
    return () => window.clearTimeout(t);
  }, [urlVin]);

  // Find the running simulator (its entrypoint randomizes the VIN) so the
  // Start button targets it on first press. Discovery runs server-side (the
  // nats client must not enter the browser bundle). Set state only in .then
  // callbacks (lint: react-hooks/set-state-in-effect); never clobber a manual
  // pick.
  useEffect(() => {
    let ignore = false;
    fetch('/api/demo/discover', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.resolve(null)))
      .then((data: { vin?: string | null } | null) => {
        if (ignore || !data?.vin) return;
        setSimulatorVin(data.vin);
        if (!userPicked.current) setVin(data.vin);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);

  // Initial status check + refresh whenever the vehicle changes. Ignore stale
  // replies for a previous VIN: an out-of-order response must never overwrite
  // the current vehicle's status. SetState only inside .then callbacks (lint:
  // react-hooks/set-state-in-effect).
  useEffect(() => {
    let ignore = false;
    fetch('/api/demo/vehicle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', vin }),
    })
      .then((res) => res.json().catch(() => null))
      .then((reply: (DemoStatus & { error?: string }) | null) => {
        if (ignore) return;
        setStatus(reply && !reply.error ? { running: reply.running, published: reply.published } : null);
      })
      .catch(() => {
        if (!ignore) setStatus(null);
      });
    return () => {
      ignore = true;
    };
  }, [vin]);

  const runAction = useCallback(
    async (action: 'start' | 'stop') => {
      setBusy(true);
      try {
        const res = await fetch('/api/demo/vehicle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, vin }),
        });
        const reply = (await res.json().catch(() => null)) as (DemoStatus & { error?: string }) | null;
        if (!res.ok || !reply || reply.error) {
          const { toast } = await import('sonner');
          toast.error(reply?.error ?? `HTTP ${res.status}`);
          setStatus(null);
          return;
        }
        setStatus({ running: reply.running, published: reply.published });
      } catch (e) {
        const { toast } = await import('sonner');
        toast.error(e instanceof Error ? e.message : 'Failed to reach demo control');
        setStatus(null);
      } finally {
        setBusy(false);
      }
    },
    [vin]
  );

  const component = DEMO_COMPONENTS.find((c) => c.id === componentId) ?? DEMO_COMPONENTS[0];
  const componentSeries = seriesForComponent(series, componentId);
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const stateView = error ? 'error' : loading ? 'loading' : componentSeries.length === 0 ? 'empty' : 'ready';

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Demo</h1>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        <DemoControlBar
          vin={vin}
          onVinChange={(v) => {
            userPicked.current = true;
            setVin(v);
          }}
          simulatorVin={simulatorVin}
          running={status?.running ?? false}
          busy={busy}
          onStart={() => runAction('start')}
          onStop={() => runAction('stop')}
        />

        <VehicleSchematic componentId={componentId} onSelect={setComponentId} series={series} />

        <DataPath flowing={status?.running ?? false} />

        {componentSeries.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {componentSeries.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggle(s.key)}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    hidden.has(s.key) ? 'opacity-40 line-through' : ''
                  }`}
                >
                  <span className="h-3 w-3 shrink-0 rounded" style={{ backgroundColor: s.color }} />
                  {s.label}
                </button>
              ))}
            </div>
            <LatestStats series={componentSeries} hidden={hidden} />
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{component.label} telemetry</CardTitle>
          </CardHeader>
          <CardContent>
            <StateView state={stateView} onRetry={refetch}>
              <TelemetryChart
                vehicleId={vin}
                series={componentSeries}
                type="line"
                axisMode="single"
                hidden={hidden}
                theme={theme}
                resetZoomToken={0}
              />
            </StateView>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

'use client';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useReducedMotion } from 'framer-motion';
import AppLayout from '@/components/app-layout';
import TimeRangeSelector from '@/components/time-range-selector';
import { LatestStats } from '@/components/latest-stats';
import { StateView } from '@/components/state-view';
import { Skeleton } from '@/components/ui/skeleton';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { qualifierOf } from '@/lib/telemetry-discovery';
import { unitsForSeries } from '@/lib/telemetry-chart-utils';
import { DataPath } from '@/components/demo/data-path';
import { DemoControlBar, VIN_POOL, type DemoStatus } from '@/components/demo/demo-control-bar';
import type { ComponentStatus } from '@/lib/demo-control';
import { VehicleSchematic } from '@/components/demo/vehicle-schematic';
import DemoScene from '@/components/scene/demo-scene';
import { FadeIn } from '@/components/motion/fade-in';
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
  const [components, setComponents] = useState<ComponentStatus[] | null>(null);
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

  // Initial status check + refresh whenever the vehicle changes, plus a light
  // poll so component toggles made elsewhere (or a simulator restart) are
  // reflected without reloading. Components come from the status reply — the
  // dashboard's discovery endpoint. SetState only inside .then callbacks
  // (lint: react-hooks/set-state-in-effect).
  const refreshStatus = useCallback(() => {
    let ignore = false;
    fetch('/api/demo/vehicle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', vin }),
    })
      .then((res) => res.json().catch(() => null))
      .then((reply: (DemoStatus & { error?: string; components?: ComponentStatus[] }) | null) => {
        if (ignore) return;
        const ok = reply && !reply.error;
        setStatus(ok ? { running: reply.running, published: reply.published } : null);
        setComponents(ok && reply.components ? reply.components : null);
      })
      .catch(() => {
        if (!ignore) {
          setStatus(null);
          setComponents(null);
        }
      });
    return () => {
      ignore = true;
    };
  }, [vin]);

  useEffect(() => {
    const interval = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  const runAction = useCallback(
    async (action: 'start' | 'stop') => {
      setBusy(true);
      try {
        // Command the live simulator, not the selected vehicle: the pool
        // picker offers VINs without a simulator, and the simulator
        // re-randomizes its VIN on container restart, so (re)discover before
        // every start/stop. Start also jumps the view to the simulator's VIN
        // so the generated telemetry is immediately visible.
        const res = await fetch('/api/demo/discover', { cache: 'no-store' });
        const data = (await res.json().catch(() => null)) as { vin?: string | null } | null;
        const target = data?.vin ?? null;
        if (!target) {
          const { toast } = await import('sonner');
          toast.error('No simulator detected — is the local stack running? Try `make demo` in local-dev/.');
          setStatus(null);
          return;
        }
        setSimulatorVin(target);
        if (action === 'start') setVin(target);
        const ctl = await fetch('/api/demo/vehicle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, vin: target }),
        });
        const reply = (await ctl.json().catch(() => null)) as (DemoStatus & { error?: string; components?: ComponentStatus[] }) | null;
        if (!ctl.ok || !reply || reply.error) {
          const { toast } = await import('sonner');
          toast.error(reply?.error ?? `HTTP ${ctl.status}`);
          setStatus(null);
          setComponents(null);
          return;
        }
        setStatus({ running: reply.running, published: reply.published });
        setComponents(reply.components ?? null);
      } catch (e) {
        const { toast } = await import('sonner');
        toast.error(e instanceof Error ? e.message : 'Failed to reach demo control');
        setStatus(null);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const component = components?.find((c) => c.id === componentId) ?? null;
  const componentSeries = useMemo(
    () =>
      component ? series.filter((s) => component.sensors.some((sig) => qualifierOf(s.column) === sig.name)) : [],
    [series, component]
  );
  // useReducedMotion is null during SSR/first paint; treat null as "not
  // reduced" so the prerendered page stays deterministic and the 3D scene
  // mounts before framer-motion resolves the media query.
  const reducedMotion = useReducedMotion() === true;
  const flowing = status?.running ?? false;
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

        <FadeIn>
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
        </FadeIn>

        {/* 3D holographic pipeline: vehicle zones (click to select) + the
            NATS→Bigtable data flow. Reduced-motion users get the SVG
            schematic + data path instead; WebGL-less browsers get them via
            the scene's fallback prop. */}
        {reducedMotion ? (
          <FadeIn>
            <VehicleSchematic componentId={componentId} onSelect={setComponentId} series={series} />
            <DataPath flowing={flowing} />
          </FadeIn>
        ) : (
          <FadeIn>
            <section className="hud-panel overflow-hidden rounded-lg">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                <h2 className="font-display text-sm font-bold tracking-[0.3em] text-cyan-700 glow-text dark:text-cyan-400">
                  HOLOGRAPHIC PIPELINE
                </h2>
                <span className="font-mono text-[11px] tracking-wider text-muted-foreground">
                  DRAG TO ORBIT · SCROLL TO ZOOM · CLICK A ZONE TO SELECT
                </span>
              </div>
              <div className="relative h-[440px] overflow-y-auto">
                <DemoScene
                  componentId={componentId}
                  onSelect={setComponentId}
                  flowing={flowing}
                  animate={!reducedMotion}
                  vin={vin}
                  fallback={
                    <div className="grid gap-4 xl:grid-cols-2">
                      <VehicleSchematic componentId={componentId} onSelect={setComponentId} series={series} />
                      <DataPath flowing={flowing} />
                    </div>
                  }
                  className="h-full w-full"
                />
              </div>
            </section>
          </FadeIn>
        )}

        {componentSeries.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {componentSeries.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggle(s.key)}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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

        <FadeIn>
          <Card>
            <CardHeader>
              <CardTitle>{component?.label ?? componentId} telemetry</CardTitle>
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
                  units={unitsForSeries(componentSeries)}
                />
              </StateView>
            </CardContent>
          </Card>
        </FadeIn>
      </div>
    </AppLayout>
  );
}

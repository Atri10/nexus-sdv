'use client';
import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import AppLayout from '@/components/app-layout';
import TimeRangeSelector from '@/components/time-range-selector';
import { LatestStats } from '@/components/latest-stats';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { useSimulatorState } from '@/hooks/use-simulator-state';
import { qualifierOf, stableComponents, unitForSignal } from '@/lib/telemetry-discovery';
import { DataPath } from '@/components/demo/data-path';
import { ComponentPanel } from '@/components/demo/component-panel';
import { ChartGrid } from '@/components/demo/chart-grid';
import { VehicleMap } from '@/components/demo/vehicle-map';
import { DemoControlBar, VIN_POOL, type DemoStatus } from '@/components/demo/demo-control-bar';
import type { ComponentStatus } from '@/lib/demo-control';
import { VehicleSchematic } from '@/components/demo/vehicle-schematic';
import DemoScene from '@/components/scene/demo-scene';
import { FadeIn } from '@/components/motion/fade-in';
import type { TimeRange } from '@/types/telemetry';
import { usePmMessages } from '@/hooks/usePmMessages';
import { severityColor, type PmMessage } from '@/lib/pm-types';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
  // A ?vin= deep link is an explicit user choice — it must NOT be clobbered
  // by the auto-discovered sim VIN on mount (the follow effect below honors
  // userPicked).
  const [vin, setVin] = useState<string>(urlVin ?? VIN_POOL[0]);
  const userPicked = useRef(Boolean(urlVin));
  const [componentId, setComponentId] = useState<string>('battery');
  const [range, setRange] = useState<TimeRange>('1h');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [components, setComponents] = useState<ComponentStatus[] | null>(null);
  // Shared simulator state — one poll loop, every page agrees.
  const simState = useSimulatorState();
  const simulatorVin = simState.vin;
  const status: DemoStatus | null = simState.sim
    ? { running: simState.sim.running, published: simState.sim.published }
    : null;

  const theme = useChartTheme();
  const { series } = useTelemetryData({ vin, range });

  // Follow the discovered sim for the default vehicle (user pick wins).
  useEffect(() => {
    if (simulatorVin && !userPicked.current) setVin(simulatorVin);
  }, [simulatorVin]);

  // No ?vin= given: randomize the default vehicle client-side (after the
  // deterministic first paint so SSR and hydration agree).
  // Component registry comes from the shared status reply — derived during
  // render (stableComponents memoizes), not via a setState effect, which the
  // react-hooks linter forbids.
  if (!components && simState.sim?.components) {
    setComponents(stableComponents(simState.sim.components));
  }

  const runAction = useCallback(
    async (action: 'start' | 'stop') => {
      setBusy(true);
      try {
        // Command the live simulator via the shared hook — the user's
        // vehicle selection is NEVER changed by Start/Stop (telemetry
        // display and simulator control are decoupled).
        const target = simState.vin;
        if (!target) {
          toast.error('No simulator detected — is the local stack running? Try `make demo` in local-dev/.');
          return;
        }
        const reply = await simState.command(action);
        if (!reply || reply.error) {
          toast.error(reply?.error ?? `Simulator did not respond`);
          return;
        }
        setComponents(reply.components ? stableComponents(reply.components) : null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to reach demo control');
      } finally {
        setBusy(false);
      }
    },
    [simState]
  );

  const component = components?.find((c) => c.id === componentId) ?? null;

  // Enable/disable one component: the simulator starts/stops publishing that
  // component's signals immediately, and the reply's component registry
  // becomes the new source of truth.
  const toggleComponent = useCallback(
    async (componentId: string, enable: boolean) => {
      setBusy(true);
      try {
        const reply = await simState.command(enable ? 'start' : 'stop', undefined, componentId);
        if (!reply || reply.error) {
          toast.error(reply?.error ?? 'Simulator did not respond');
          return;
        }
        if (reply.components) setComponents(stableComponents(reply.components));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to toggle component');
      } finally {
        setBusy(false);
      }
    },
    [simState]
  );
  const componentSeries = useMemo(
    () =>
      component ? series.filter((s) => component.sensors.some((sig) => qualifierOf(s.column) === sig.name)) : [],
    [series, component]
  );
  // Predictive maintenance: latest pm message per component (usePmMessages
  // prepends newest-first). Keyed by component id and consumed as the
  // ComponentPanel `health` prop (gauge score/severity) and the schematic's
  // `alertState` (pulsing node badges).
  const { messages: pmMessages, clearAlerts } = usePmMessages();
  // PM health/alert state is scoped to the SELECTED VIN (the vehicle being
  // inspected), never mixed across VINs — the detector publishes for every
  // VIN it polls, and the sim VIN may differ from the selection.
  const selectedPm = useMemo(
    () => pmMessages.filter((m) => m.vin === vin),
    [pmMessages, vin]
  );
  const latestByComponent = useMemo(() => {
    const m = new Map<string, PmMessage>();
    for (const msg of selectedPm) if (!m.has(msg.component)) m.set(msg.component, msg);
    return m;
  }, [selectedPm]);
  const health = Object.fromEntries([...latestByComponent.entries()].map(([k, v]) => [k, { score: v.health_score, severity: v.severity }]));
  const alertState = Object.fromEntries([...latestByComponent.entries()].map(([k, v]) => [k, { severity: v.severity }]));
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

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Demo</h1>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        {/* ============ SECTION: CONTROL ============ */}
        <Section title="Simulator control" meta={simulatorVin ? `sim: ${simulatorVin}` : 'no simulator detected'}>
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
          <ComponentPanel
            components={components}
            simulatorVin={simulatorVin}
            busy={busy}
            onToggle={toggleComponent}
            health={health}
          />
        </Section>

        {/* ============ SECTION: PM ALERTS ============ */}
        <Section title="PM alerts" meta={vin}>
          {selectedPm.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No PM alerts for {vin} yet — alerts appear as the detector crosses
              severity bands.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => {
                    clearAlerts();
                    toast.success('Alerts cleared');
                  }}
                  className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  Clear alerts
                </button>
              </div>
              <div className="flex gap-4 overflow-x-auto">
                {selectedPm.slice(0, 8).map((m, i) => (
                  <span key={i} className="whitespace-nowrap font-mono text-sm">
                    <span style={{ color: severityColor(m.severity) }}>{m.severity.toUpperCase()}</span>
                    <span className="text-muted-foreground"> · {m.vin} · {m.component} · {m.explanation}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </Section>

        {/* ============ SECTION: LIVE PIPELINE ============ */}
        <Section title="Live pipeline" meta="vehicle + data flow">
          {reducedMotion ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <VehicleSchematic componentId={componentId} onSelect={setComponentId} series={series} components={components} alertState={alertState} />
              <DataPath flowing={flowing} />
            </div>
          ) : (
            <div className="relative h-[440px] overflow-hidden rounded-lg border border-border/60">
              <DemoScene
                componentId={componentId}
                onSelect={setComponentId}
                flowing={flowing}
                animate={!reducedMotion}
                vin={vin}
                components={components}
                fallback={
                  <div className="grid gap-4 xl:grid-cols-2">
                    <VehicleSchematic componentId={componentId} onSelect={setComponentId} series={series} components={components} alertState={alertState} />
                    <DataPath flowing={flowing} />
                  </div>
                }
                className="h-full w-full"
              />
            </div>
          )}
        </Section>

        {/* ============ SECTION: TELEMETRY ============ */}
        <Section title="Telemetry" meta={`${vin} · ${range}`}>
          <VehicleMap
            series={series}
            paused={!(components?.find((c) => c.id === 'chassis')?.enabled ?? true)}
          />
          {componentSeries.length > 0 && (
            <LatestStats
              series={componentSeries}
              hidden={hidden}
              units={Object.fromEntries(
                componentSeries
                  .map((s) => [s.key, unitForSignal(components, qualifierOf(s.column))])
                  .filter((entry): entry is [string, string] => entry[1] !== undefined)
              )}
            />
          )}
          <ChartGrid
            series={series}
            components={components}
            hidden={hidden}
            theme={theme}
            onToggleSeries={toggle}
          />
        </Section>
      </div>
    </AppLayout>
  );
}

/** Recursive section wrapper: consistent card anatomy (title + meta +
 * children) shared across pages. */
function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <FadeIn>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle className="text-base font-semibold">{title}</CardTitle>
            {meta && <span className="font-mono text-xs text-muted-foreground">{meta}</span>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">{children}</CardContent>
      </Card>
    </FadeIn>
  );
}

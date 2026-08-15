'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import nextDynamic from 'next/dynamic';
import AppLayout from '@/components/app-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FadeIn } from '@/components/motion/fade-in';
import { RoutePanel } from '@/components/pm/route-panel';
import { usePmMessages } from '@/hooks/usePmMessages';
import { useSimulatorState } from '@/hooks/use-simulator-state';
import { severityColor, type PmMessage } from '@/lib/pm-types';
import type { PmSample } from '@/components/pm/pm-charts';
import { DEMO_ROUTE_TOTAL_M } from '@/lib/pm-route';
import { RotateCcw, Square, Play, Zap } from 'lucide-react';
import { toast } from 'sonner';

// Live-data console: never statically prerender (the page streams live
// telemetry + PM events; SSR evaluation of the chart stack is unnecessary
// and touches browser-only APIs at module scope).
export const dynamic = 'force-dynamic';

// Charts are loaded on the client only (Chart.js + zoom touch browser APIs
// at module scope; SSR must never evaluate them).
const PmCharts = nextDynamic(() => import('@/components/pm/pm-charts').then((m) => m.PmCharts), {
  ssr: false,
  loading: () => (
    <div className="grid gap-4 md:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-44 animate-pulse rounded-lg border border-border/60 bg-card/40" />
      ))}
    </div>
  ),
});

type Vehicle = {
  deviceId: string;
  lastSeen: string;
  columns: Record<string, string>;
};

const SPEED_OPTIONS = [1, 5, 20];
const CHART_WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling window
const MAX_SAMPLES = 600; // hard cap on top of the window (10 min @ ~1/s)

/**
 * Predictive-Maintenance live showcase — single vehicle.
 *
 * Pick one vehicle → watch it drive the predefined route repeatedly → watch
 * the same components degrade as laps accumulate → see the metrics, charts
 * and PM alerts change live. No fleet matrix, no drill-down: one screen that
 * tells the "same route, repeated laps, accumulating degradation" story.
 */
export default function PmPage() {
  const { messages, clearAlerts } = usePmMessages();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [selectedVin, setSelectedVin] = useState<string | null>(null);
  const [samples, setSamples] = useState<PmSample[]>([]);
  const [busy, setBusy] = useState(false);
  const lastSamples = useRef<PmSample[]>([]);
  const userPicked = useRef(false);
  // Shared simulator state — one poll loop, every page agrees.
  const simState = useSimulatorState();
  const simVin = simState.vin;
  const sim = simState.sim;

  // Follow the discovered sim for the default selection (user pick wins).
  useEffect(() => {
    if (simVin && !userPicked.current) setSelectedVin(simVin);
  }, [simVin]);

  // Latest pm message per component for the selected VIN (newest-first input).
  const selectedMessages = useMemo(
    () => (selectedVin ? messages.filter((m) => m.vin === selectedVin) : []),
    [messages, selectedVin]
  );

  const latestPerComponent = useMemo(() => {
    const map = new Map<string, PmMessage>();
    for (const m of selectedMessages) {
      if (!map.has(m.component)) map.set(m.component, m);
    }
    return map;
  }, [selectedMessages]);

  // ---- Vehicle list + selection -------------------------------------------
  const loadVehicles = useCallback(() => {
    fetch('/api/devices')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        const list = (d.devices ?? []) as Vehicle[];
        setVehicles(list);
        // Never let the Bigtable-derived device list decide the selection:
        // it includes stale rows for VINs without a simulator. Discovery
        // (below) is the authority for the default.
        setSelectedVin((prev) => prev ?? null);
      })
      .catch((e: unknown) => console.error('load vehicles', e))
      .finally(() => setVehiclesLoading(false));
  }, []);

  useEffect(() => {
    loadVehicles();
    const id = window.setInterval(loadVehicles, 5000);
    return () => window.clearInterval(id);
  }, [loadVehicles]);

  // ---- Simulator control (start/stop) --------------------------------------
  // Explicit user actions only — the page NEVER auto-starts a simulator the
  // user (or /demo) stopped. Commands go through the shared hook so every
  // page sees the new state immediately.
  const runAction = useCallback(
    async (action: 'start' | 'stop') => {
      if (!simVin) {
        toast.error('No simulator detected — is the local stack running?');
        return;
      }
      setBusy(true);
      try {
        const reply = await simState.command(action);
        if (!reply || reply.error) {
          toast.error(reply?.error ?? 'Simulator did not respond');
          return;
        }
        if (action === 'start' && !userPicked.current) setSelectedVin(simVin);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to control simulator');
      } finally {
        setBusy(false);
      }
    },
    [simVin, simState]
  );

  // ---- Demo speed + reset ---------------------------------------------------
  const setSpeed = useCallback(
    async (mult: number) => {
      if (!simVin) return;
      setBusy(true);
      try {
        const reply = await simState.command('speed', String(mult));
        if (!reply || reply.error) {
          toast.error(reply?.error ?? 'Simulator did not respond');
          return;
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to set demo speed');
      } finally {
        setBusy(false);
      }
    },
    [simVin, simState]
  );

  const resetDemo = useCallback(async () => {
    if (!simVin) {
      toast.error('No simulator detected — nothing to reset.');
      return;
    }
    setBusy(true);
    try {
      const reply = await simState.command('reset');
      if (!reply || reply.error) {
        toast.error(reply?.error ?? 'Simulator did not respond');
        return;
      }
      lastSamples.current = [];
      setSamples([]);
      // The reset restores the vehicle to healthy — wipe the accumulated
      // alert list too so the PM events section doesn't show a dead
      // battery's old alerts after the reset. (The detector publishes on
      // severity change; if the fleet is still degrading, fresh alerts
      // re-appear as bands re-cross.)
      clearAlerts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reset demo');
    } finally {
      setBusy(false);
    }
  }, [simVin, simState, clearAlerts]);

  // ---- Live sample buffer (charts) ----------------------------------------
  // Append a sample every poll from the freshest available source. When the
  // selected VIN is NOT the running sim (or the sim is down), skip appending
  // entirely — null samples would pollute the charts (BUG-8).
  const recordSample = useCallback(() => {
    // Skip when the selection isn't the sim OR the sim isn't running:
    // a stopped sim's frozen last values would flatline the charts and
    // age real history out of the window (BUG-P3-1).
    if (simVin && selectedVin && simVin !== selectedVin) return;
    if (!sim?.running) return;
    const t = Date.now();
    const gt = sim?.ground_truth ?? {};
    const liveVals = (sim?.live ?? {}) as Record<string, unknown>;
    const prev = lastSamples.current;
    if (prev.length && t - prev[prev.length - 1].t < 500) return;
    const health = latestPerComponent.get('battery')?.health_score ?? null;
    const voltage = Number(liveVals.battery_voltage ?? NaN);
    const brakeWear =
      (gt.brake as Record<string, unknown> | undefined)?.wear_fraction !== undefined
        ? Number((gt.brake as Record<string, unknown>).wear_fraction)
        : null;
    const tirePressure = Number(liveVals.tire_pressure_bar ?? NaN);
    const next: PmSample = {
      t,
      health,
      voltage: Number.isFinite(voltage) ? voltage : null,
      brakeWear,
      tirePressure: Number.isFinite(tirePressure) ? tirePressure : null,
    };
    lastSamples.current = [...prev, next].slice(-MAX_SAMPLES);
    setSamples(lastSamples.current);
  }, [sim, latestPerComponent, simVin, selectedVin]);

  useEffect(() => {
    recordSample();
    const id = window.setInterval(recordSample, 2000);
    return () => window.clearInterval(id);
  }, [recordSample]);

  // Trim the buffer to the rolling window (kept separate so the charts only
  // re-render when a sample actually ages out).
  const windowedSamples = useMemo(() => {
    const cutoff = Date.now() - CHART_WINDOW_MS;
    const trimmed = samples.filter((s) => s.t >= cutoff);
    return trimmed.length === samples.length ? samples : trimmed;
  }, [samples]);

  // ---- Derived display values ----------------------------------------------
  const vehicle = vehicles.find((v) => v.deviceId === selectedVin);
  const liveVals = (sim?.live ?? {}) as Record<string, unknown>;
  const speedMs = Number(liveVals.velocity_m_s ?? NaN);
  const speedKmh = Number.isFinite(speedMs) ? speedMs * 3.6 : NaN;
  const batteryV = Number(liveVals.battery_voltage ?? NaN);
  const tireBar = Number(liveVals.tire_pressure_bar ?? NaN);
  const batteryMsg = latestPerComponent.get('battery');
  const brakeMsg = latestPerComponent.get('brake');
  const tiresMsg = latestPerComponent.get('tires');
  const route = sim?.route;
  const lapInfo = route?.lap as { number?: number; progress?: number } | undefined;
  const lap = lapInfo?.number ?? 0;
  const progress = lapInfo?.progress ?? 0;
  const speedMult = sim?.speed ?? 1;
  const gtBrake = sim?.ground_truth?.brake as Record<string, unknown> | undefined;
  const brakeWearFrac = gtBrake?.wear_fraction !== undefined ? Number(gtBrake.wear_fraction) : 0;

  // P3-2: 'live' must be false when the sim is stopped OR the selection isn't
  // the sim — the KPI row shows sim.live values, so it must not present them
  // as live when they're frozen or belong to a different vehicle. (The old
  // `Number(x) !== undefined` was always true — NaN !== undefined.)
  const live = sim?.running === true && simVin === selectedVin && Number.isFinite(Number(liveVals.velocity_m_s));

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Header: vehicle selection (what data you view) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Predictive Maintenance</h1>
            <span className="rounded border border-border/70 bg-card/50 px-2 py-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Same route · repeated laps · accelerated wear
            </span>
          </div>
          <div className="flex items-center gap-2">
            {vehicles.length > 0 ? (
              <select
                value={selectedVin ?? ''}
                onChange={(e) => {
                  userPicked.current = true;
                  setSelectedVin(e.target.value);
                  lastSamples.current = [];
                  setSamples([]);
                }}
                aria-label="Select vehicle"
                className="rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-sm text-foreground outline-none focus:border-blue-500"
              >
                {vehicles.map((v) => (
                  <option key={v.deviceId} value={v.deviceId}>
                    {v.deviceId}
                    {v.deviceId === simVin ? ' · SIM' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm text-muted-foreground">
                {vehiclesLoading ? 'Loading vehicles…' : 'No vehicles yet'}
              </span>
            )}

            {/* Demo speed */}
            <div className="flex items-center gap-1 rounded-md border border-border/70 bg-card/50 p-1">
              <span className="px-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Demo
              </span>
              {SPEED_OPTIONS.map((mult) => (
                <button
                  key={mult}
                  onClick={() => setSpeed(mult)}
                  disabled={busy || !simVin}
                  aria-pressed={speedMult === mult}
                  className={`rounded px-2 py-1 font-mono text-xs transition-colors ${
                    speedMult === mult
                      ? 'bg-blue-500/15 text-blue-500'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  {mult}×
                </button>
              ))}
            </div>

            {/* Simulator control — explicit, never auto-started (BUG-1). */}
            <Button
              variant={sim?.running ? 'destructive' : 'default'}
              size="sm"
              onClick={() => runAction(sim?.running ? 'stop' : 'start')}
              disabled={busy || !simVin}
              className="gap-1.5"
            >
              {sim?.running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {sim?.running ? 'Stop' : 'Start'}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={resetDemo}
              disabled={busy || !simVin}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset demo
            </Button>
          </div>
        </div>

        {/* ============ SECTION: SIMULATOR ============ */}
        <Section title="Simulator" meta={simVin ? simVin : undefined}>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 ${
                live
                  ? 'border-green-500/40 bg-green-500/10 text-green-600'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-600'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse bg-green-500' : 'bg-amber-500'}`} />
              {live ? 'SIM LIVE' : simVin ? 'SIM STOPPED' : 'NO SIMULATOR'}
            </span>
            {simVin && selectedVin !== simVin && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-600">
                viewing {selectedVin} — sim is {simVin}
              </span>
            )}
            {speedMult > 1 && (
              <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-amber-500">
                <Zap className="h-3 w-3" />
                FAST DEMO · {speedMult}×
              </span>
            )}
          </div>

          {/* Route + lap */}
          <FadeIn>
            <RoutePanel
              progress={progress}
              lap={lap}
              totalM={route?.total_m ?? DEMO_ROUTE_TOTAL_M}
              speed={speedMult}
            />
          </FadeIn>

          {/* Live KPIs — values come from the running simulator. When viewing
              a different vehicle, the caption says so. */}
          <div className="text-sm font-mono text-muted-foreground">
            {simVin && selectedVin !== simVin
              ? `LIVE VALUES · ${simVin} (simulator) · PM STATE · ${selectedVin}`
              : simVin
                ? `LIVE VALUES · ${simVin}`
                : 'SIMULATOR STOPPED — start it to see live values'}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Kpi label="Speed" value={Number.isFinite(speedKmh) ? `${speedKmh.toFixed(1)} km/h` : '—'} />
            <Kpi
              label="Battery voltage"
              value={Number.isFinite(batteryV) ? `${batteryV.toFixed(2)} V` : '—'}
              tone={batteryMsg ? severityColor(batteryMsg.severity) : undefined}
            />
            <Kpi
              label="Battery health"
              value={batteryMsg ? `${batteryMsg.health_score}%` : '—'}
              tone={batteryMsg ? severityColor(batteryMsg.severity) : undefined}
            />
            <Kpi
              label="Brake wear"
              value={`${(brakeWearFrac * 100).toFixed(0)}%`}
              tone={brakeMsg ? severityColor(brakeMsg.severity) : undefined}
            />
            <Kpi
              label="Tire pressure"
              value={Number.isFinite(tireBar) ? `${tireBar.toFixed(2)} bar` : '—'}
              tone={tiresMsg ? severityColor(tiresMsg.severity) : undefined}
            />
          </div>
        </Section>

        {/* ============ SECTION: COMPONENT HEALTH ============ */}
        <Section title="Component health" meta={selectedVin ?? undefined}>
          <div className="flex flex-wrap items-center gap-3">
            <ComponentBadge label="Battery" msg={batteryMsg} />
            <ComponentBadge label="Brakes" msg={brakeMsg} />
            <ComponentBadge label="Tires" msg={tiresMsg} />
          </div>

          {/* Live charts */}
          <FadeIn>
            <PmCharts samples={windowedSamples} />
          </FadeIn>
        </Section>

        {/* ============ SECTION: PM EVENTS ============ */}
        <Section
          title="PM events"
          meta={selectedVin ?? 'no vehicle'}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearAlerts();
                toast.success('Alerts cleared');
              }}
              disabled={selectedMessages.length === 0}
              className="gap-1.5"
            >
              Clear alerts
            </Button>
          }
        >
          {selectedMessages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No PM events for this vehicle yet — with Fast Demo enabled, degradation
              accumulates and alerts fire within a minute or two.
            </p>
          ) : (
            <div className="max-h-44 space-y-1.5 overflow-y-auto">
              {selectedMessages.slice(0, 20).map((m, i) => (
                <div key={`${m.timestamp}-${m.component}-${i}`} className="flex items-start gap-2 text-sm">
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {new Date(m.timestamp).toLocaleTimeString()}
                  </span>
                  <Badge
                    className={`shrink-0 font-mono text-xs uppercase tracking-wider ${
                      m.severity === 'healthy' ? 'opacity-60' : ''
                    }`}
                    style={{
                      backgroundColor: `${severityColor(m.severity)}26`,
                      color: severityColor(m.severity),
                    }}
                  >
                    {m.severity}
                  </Badge>
                  <span className="font-mono text-xs uppercase text-foreground/90">{m.component}</span>
                  <span className="text-foreground/85">{m.explanation}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </AppLayout>
  );
}

/** Recursive section wrapper: consistent card anatomy (title + meta +
 * children) so every page group reads identically. */
function Section({
  title,
  meta,
  action,
  children,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <FadeIn>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <CardTitle className="text-base font-semibold">{title}</CardTitle>
              {meta && (
                <span className="font-mono text-xs text-muted-foreground">{meta}</span>
              )}
            </div>
            {action}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">{children}</CardContent>
      </Card>
    </FadeIn>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 px-3 py-2.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className="mt-1 font-mono text-xl font-semibold tabular-nums"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function ComponentBadge({ label, msg }: { label: string; msg?: PmMessage }) {
  const sev = msg?.severity ?? 'healthy';
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase"
        style={{ color: severityColor(sev) }}
      >
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: severityColor(sev) }} />
        {sev}
      </span>
    </div>
  );
}

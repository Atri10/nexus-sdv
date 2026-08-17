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
import {
  coherentHealth,
  clearPmState,
  deriveDeathCause,
  worstWheel,
  friendlyAlert,
  liveSignalsFromSimulator,
  WHEELS,
  type CoherentHealth,
  type DeathCause,
  type Wheel,
} from '@/lib/pm-health';
import type { PmSample } from '@/components/pm/pm-charts';
import { DEMO_ROUTE_TOTAL_M } from '@/lib/pm-route';
import {
  commandsForScenario,
  FAULT_SCENARIO_HELP,
  FAULT_SCENARIO_LABELS,
  type FaultIntensity,
  type FaultScenario,
} from '@/lib/pm-degradation';
import { RotateCcw, Square, Play, Zap, AlertTriangle } from 'lucide-react';
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
  const [faultScenario, setFaultScenario] = useState<FaultScenario>('healthy');
  const [faultIntensity, setFaultIntensity] = useState<FaultIntensity>('critical');
  const lastSamples = useRef<PmSample[]>([]);
  const userPicked = useRef(false);
  // Shared simulator state — one poll loop, every page agrees.
  const simState = useSimulatorState();
  const simVin = simState.vin;
  const sim = simState.sim;
  const simRef = useRef(sim);
  const simVinRef = useRef(simVin);
  const latestPerComponentRef = useRef<Map<string, PmMessage>>(new Map());
  const selectedVinRef = useRef(selectedVin);
  const lastPublishedRef = useRef<number | null>(null);
  const wasRunningRef = useRef(false);

  // Follow the discovered sim for the default selection (user pick wins).
  useEffect(() => {
    if (simVin && !userPicked.current) setSelectedVin(simVin);
  }, [simVin]);

  // Clear-on-switch: when the simulator ADOPTS a new VIN (runtime VIN
  // switching — Start with a different pool VIN runs a fresh vehicle), the
  // previous VIN's data must not linger. Drop the PM message list (via
  // clearAlerts so sessionStorage + generation stay consistent), the
  // per-component health map (derived — resets with the messages) and the
  // chart buffers so only the new VIN's data shows. Guarded so a stale
  // first discovery doesn't wipe a fresh session on mount.
  const prevSimVin = useRef<string | null>(null);
  useEffect(() => {
    if (simVin === null) return;
    if (prevSimVin.current !== null && prevSimVin.current !== simVin) {
      lastSamples.current = [];
      lastPublishedRef.current = null;
      wasRunningRef.current = false;
      clearPmState({ setMessages: clearAlerts, setSamples });
      // The selection follows the new sim only if the user never picked a
      // vehicle explicitly; otherwise keep viewing what the user chose.
      if (!userPicked.current) setSelectedVin(simVin);
    }
    prevSimVin.current = simVin;
  }, [simVin, clearAlerts, setSamples]);

  // Latest pm message per component for the selected VIN (newest-first input).
  const selectedMessages = useMemo(
    () => (selectedVin ? messages.filter((m) => m.vin === selectedVin) : []),
    [messages, selectedVin]
  );

  // Latest pm message per component+wheel for the selected VIN (newest-first
  // input). Wheeled subjects (tires/brake) key as '{component}.{wheel}';
  // battery keys as 'battery'. The newest message per instance wins.
  const latestPerComponent = useMemo(() => {
    const map = new Map<string, PmMessage>();
    for (const m of selectedMessages) {
      const key = m.wheel ? `${m.component}.${m.wheel}` : m.component;
      if (!map.has(key)) map.set(key, m);
    }
    return map;
  }, [selectedMessages]);

  useEffect(() => {
    simRef.current = sim;
    simVinRef.current = simVin;
    selectedVinRef.current = selectedVin;
    latestPerComponentRef.current = latestPerComponent;
  }, [sim, simVin, selectedVin, latestPerComponent]);

  // Summary messages per component: the WORST wheel/pad instance drives the
  // badge (min health_score) so a single flat tire is never masked by four
  // healthy ones; battery has no wheel and uses its single message.
  const componentSummary = useMemo(() => {
    const battery = latestPerComponent.get('battery');
    const brakeWheels = WHEELS.map((w) => latestPerComponent.get(`brake.${w}`)).filter(
      (m): m is PmMessage => m !== undefined
    );
    const tireWheels = WHEELS.map((w) => latestPerComponent.get(`tires.${w}`)).filter(
      (m): m is PmMessage => m !== undefined
    );
    return {
      battery,
      brake: worstWheel(brakeWheels) ?? undefined,
      tires: worstWheel(tireWheels) ?? undefined,
      brakeWheels,
      tireWheels,
    };
  }, [latestPerComponent]);

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
        // A dead vehicle (battery died / tire flat) must be RESET before it
        // can start again — starting a corpse is logically incoherent. The
        // reset re-seeds age 0 + fresh curves, then start enables components.
        if (action === 'start' && sim?.dead) {
          const resetReply = await simState.command('reset');
          if (!resetReply || resetReply.error) {
            toast.error(resetReply?.error ?? 'Simulator did not respond to reset');
            return;
          }
        }
        // Runtime VIN switching: Start for a different pool VIN makes the
        // simulator adopt it (select VIN1002 + Start actually runs a fresh
        // VIN1002). Pass the SELECTED VIN as the command target so the body
        // carries it for adopt; stop always targets the running sim.
        const target = action === 'start' && selectedVin ? selectedVin : simVin;
        const reply = await simState.command(action, undefined, undefined, target);
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
    [sim, simVin, selectedVin, simState]
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

  const applyFaultScenario = useCallback(async () => {
    if (!simVin) {
      toast.error('No simulator detected — is the local stack running?');
      return;
    }
    setBusy(true);
    try {
      const wasRunning = sim?.running === true;
      if (wasRunning) {
        const stopped = await simState.command('stop');
        if (!stopped || stopped.error) throw new Error(stopped?.error ?? 'Simulator did not stop');
      }

      // Apply a complete scenario from a fresh age/energy baseline. This
      // prevents a previous tire fault or brake accumulator from contaminating
      // the component the engineer is trying to test.
      const reset = await simState.command('reset');
      if (!reset || reset.error) throw new Error(reset?.error ?? 'Simulator did not reset');
      for (const command of commandsForScenario(faultScenario, faultIntensity)) {
        const reply = await simState.command('degradation', command.preset, command.component);
        if (!reply || reply.error) throw new Error(reply?.error ?? `Could not configure ${command.component}`);
      }

      lastSamples.current = [];
      lastPublishedRef.current = null;
      wasRunningRef.current = false;
      setSamples([]);
      clearAlerts();

      if (wasRunning) {
        const started = await simState.command('start', undefined, undefined, selectedVin ?? simVin);
        if (!started || started.error) throw new Error(started?.error ?? 'Simulator did not restart');
      }
      toast.success(`${FAULT_SCENARIO_LABELS[faultScenario]} scenario applied`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to configure degradation');
    } finally {
      setBusy(false);
    }
  }, [clearAlerts, faultIntensity, faultScenario, selectedVin, sim, simState, simVin]);

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
      lastPublishedRef.current = null;
      wasRunningRef.current = false;
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
  // Append one sample per simulator publish counter, rather than one sample
  // per browser poll. The status endpoint polls every 3s while the simulator
  // ticks every 2s, so the counter prevents duplicate snapshots and makes the
  // chart's point count reflect actual simulator updates.
  const recordSample = useCallback(() => {
    const currentSim = simRef.current;
    const currentSimVin = simVinRef.current;
    const currentSelectedVin = selectedVinRef.current;
    if (currentSimVin && currentSelectedVin && currentSimVin !== currentSelectedVin) return;

    const t = Date.now();
    const canShowSnapshot = currentSim?.running === true || currentSim?.dead === true;
    const previous = lastSamples.current;
    if (!canShowSnapshot) {
      if (wasRunningRef.current && previous.length > 0 && !previous[previous.length - 1].gap) {
        lastSamples.current = [
          ...previous,
          { t, gap: true, health: null, voltage: null, brakeWear: null, tirePressure: null },
        ].slice(-MAX_SAMPLES);
        setSamples(lastSamples.current);
      }
      wasRunningRef.current = false;
      return;
    }

    const published = Number(currentSim.published);
    if (!Number.isFinite(published)) return;
    const gt = currentSim.ground_truth ?? {};
    const liveVals = (currentSim.live ?? {}) as Record<string, unknown>;
    const voltage = Number(liveVals.battery_voltage ?? NaN);
    const batterySignals = liveSignalsFromSimulator(currentSim);
    const health = coherentHealth(
      'battery',
      latestPerComponentRef.current.get('battery'),
      batterySignals,
    ).score;
    // A death-stop writes one final status snapshot but does not increment
    // published because it intentionally sends no telemetry payload. Accept
    // that one terminal snapshot; later identical polls are ignored after the
    // explicit gap has been appended below.
    if (currentSim.dead && previous.length > 0 && previous[previous.length - 1].gap) {
      wasRunningRef.current = currentSim.running === true;
      return;
    }
    const lastSample = previous[previous.length - 1];
    const healthChanged = !lastSample?.gap && lastSample?.health !== health;
    if (lastPublishedRef.current === published && !currentSim.dead && !healthChanged) {
      wasRunningRef.current = currentSim.running === true;
      return;
    }

    if (lastPublishedRef.current === published && !currentSim.dead && healthChanged && lastSample) {
      const updated = [...previous];
      updated[updated.length - 1] = { ...lastSample, health };
      lastSamples.current = updated;
      setSamples(updated);
      return;
    }

    lastPublishedRef.current = published;
    wasRunningRef.current = currentSim.running === true;
    const brakeGt = gt.brake as Record<string, unknown> | undefined;
    const brakeWear = brakeGt?.wear_fraction !== undefined ? Number(brakeGt.wear_fraction) : null;
    const gtBrakes = (gt.brakes ?? {}) as Record<string, unknown>;
    const padWears = WHEELS.map((w) => {
      const padGt = gtBrakes[w] as Record<string, unknown> | undefined;
      const f = padGt && typeof padGt === 'object' ? padGt.wear_fraction : undefined;
      return typeof f === 'number' && Number.isFinite(f) ? f : NaN;
    }).filter((f) => Number.isFinite(f));
    const brakeWearSample = padWears.length > 0 ? Math.max(...padWears) : brakeWear;
    const gtTires = (gt.tires ?? {}) as Record<string, unknown>;
    const wheelPressures = WHEELS.map((w) => {
      const wheelGt = gtTires[w] as Record<string, unknown> | undefined;
      const p = wheelGt && typeof wheelGt === 'object' ? wheelGt.pressure_bar : undefined;
      return typeof p === 'number' && Number.isFinite(p) ? p : NaN;
    }).filter((p) => Number.isFinite(p));
    const tirePressure = wheelPressures.length > 0 ? Math.min(...wheelPressures) : Number(liveVals.tire_pressure_bar ?? NaN);
    const tirePressures: Partial<Record<Wheel, number | null>> = {};
    const brakeWears: Partial<Record<Wheel, number | null>> = {};
    for (const w of WHEELS) {
      const tw = gtTires[w] as Record<string, unknown> | undefined;
      const p = tw && typeof tw === 'object' ? tw.pressure_bar : undefined;
      tirePressures[w] = typeof p === 'number' && Number.isFinite(p) ? p : null;
      const bw = gtBrakes[w] as Record<string, unknown> | undefined;
      const f = bw && typeof bw === 'object' ? bw.wear_fraction : undefined;
      brakeWears[w] = typeof f === 'number' && Number.isFinite(f) ? f : null;
    }
    const next: PmSample = {
      t,
      health,
      voltage: Number.isFinite(voltage) ? voltage : null,
      brakeWear: brakeWearSample,
      tirePressure: Number.isFinite(tirePressure) ? tirePressure : null,
      tirePressures,
      brakeWears,
    };
    lastSamples.current = [...previous, next].slice(-MAX_SAMPLES);
    setSamples(lastSamples.current);
    if (currentSim.dead) {
      lastSamples.current = [
        ...lastSamples.current,
        { t: t + 1, gap: true, health: null, voltage: null, brakeWear: null, tirePressure: null },
      ].slice(-MAX_SAMPLES);
      setSamples(lastSamples.current);
      wasRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    recordSample();
  }, [recordSample, sim, latestPerComponent]);

  // Trim the buffer to the rolling window (kept separate so the charts only
  // re-render when a sample actually ages out). The cutoff is derived from a
  // wall-clock state refreshed by the interval — the memo reads it, so the
  // cutoff is a render-cycle value, not an impure Date.now() inside useMemo
  // nor a ref read during render (both react-hooks violations).
  const [wallClock, setWallClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setWallClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const windowedSamples = useMemo(() => {
    const cutoff = wallClock - CHART_WINDOW_MS;
    const trimmed = samples.filter((s) => s.t >= cutoff);
    return trimmed.length === samples.length ? samples : trimmed;
  }, [samples, wallClock]);

  // ---- Derived display values ----------------------------------------------
  const liveVals = (sim?.live ?? {}) as Record<string, unknown>;
  const speedMs = Number(liveVals.velocity_m_s ?? NaN);
  const speedKmh = Number.isFinite(speedMs) ? speedMs * 3.6 : NaN;
  const liveSignals = useMemo(() => liveSignalsFromSimulator(sim), [sim]);
  const batteryV = liveSignals.batteryVoltage ?? NaN;
  const batterySoc = Number(liveVals.battery_soc ?? NaN);
  const tireBar = liveSignals.tirePressure ?? NaN;
  const batteryMsg = componentSummary.battery;
  const brakeMsg = componentSummary.brake;
  const tiresMsg = componentSummary.tires;
  const route = sim?.route;
  const lapInfo = route?.lap as { number?: number; progress?: number } | undefined;
  const lap = lapInfo?.number ?? 0;
  const progress = lapInfo?.progress ?? 0;
  const speedMult = sim?.speed ?? 1;
  // Per-pad brake wear: the sim reply carries brakes.{wheel}.wear_fraction.
  // The worst pad drives the provisional brake badge when present. The raw
  // brakes map is the memo dep (stable across renders).
  const worstPadWearFrac = liveSignals.brakeWearFrac ?? 0;
  const tirePressures = liveSignals.tirePressures ?? {};
  // Worst per-wheel pressure (drives the KPI + provisional badge); falls back
  // to the legacy single-channel live value when no wheel data is present.
  const wheelBars = WHEELS.map((w) => tirePressures[w]).filter(
    (p): p is number => p !== null && p !== undefined
  );
  const worstTireBar = wheelBars.length > 0 ? Math.min(...wheelBars) : tireBar;
  // Coherent health: authoritative PM message when available, otherwise
  // derived provisionally from the live values — so badges, KPIs and charts
  // always agree (a battery at 11.0 V is never 'HEALTHY' just because the
  // detector hasn't published yet). The tires aggregate uses the worst
  // per-wheel pressure.
  const coherent = useMemo(
    () => ({
      battery: coherentHealth('battery', batteryMsg, liveSignals),
      brake: coherentHealth('brake', brakeMsg, liveSignals),
      tires: coherentHealth('tires', tiresMsg, liveSignals),
    }),
    [batteryMsg, brakeMsg, tiresMsg, liveSignals]
  );
  const deathCause = useMemo<DeathCause | null>(() => {
    if (!sim?.dead) return null;

    if (sim.dead_component === 'battery') return { component: 'battery' };
    if (sim.dead_component === 'tires') {
      const wheel = WHEELS.find((candidate) => candidate === sim.dead_wheel);
      if (wheel) {
        const values = (sim.ground_truth?.tires?.[wheel] ?? {}) as Record<string, unknown>;
        const pressure = Number(values.pressure_bar);
        return {
          component: 'tires',
          wheel,
          pressureBar: Number.isFinite(pressure) ? pressure : undefined,
        };
      }
    }
    return deriveDeathCause(sim.ground_truth);
  }, [sim]);
  // P3-2: 'live' must be false when the sim is stopped OR the selection isn't
  // the sim — the KPI row shows sim.live values, so it must not present them
  // as live when they're frozen or belong to a different vehicle. (The old
  // `Number(x) !== undefined` was always true — NaN !== undefined.)
  const live = sim?.running === true && simVin === selectedVin && Number.isFinite(Number(liveVals.velocity_m_s));
  const frozen = !live;
  const deathMessage =
    deathCause?.component === 'tires' && deathCause.wheel
      ? `Vehicle stopped — ${wheelLabel(deathCause.wheel)} tire pressure collapsed to ${deathCause.pressureBar?.toFixed(2) ?? 'critical'} bar.`
      : deathCause?.component === 'battery'
        ? `Vehicle stopped — the 12V battery reached end of life (0% health${Number.isFinite(batteryV) ? `; ${batteryV.toFixed(2)} V terminal reading` : ''}).`
        : 'Vehicle reached end-of-life — simulation stopped';
  const activeDegradation = Object.entries(sim?.degradation ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, config]) => `${component} ${config.preset}`)
    .join(' · ');

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
                  lastPublishedRef.current = null;
                  wasRunningRef.current = false;
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

            {/* Controlled fault injection: reset first so one test cannot
                inherit a prior component's degradation or brake energy. */}
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-1">
              <span className="px-1.5 text-xs font-semibold uppercase tracking-wider text-amber-600">
                Test fault
              </span>
              <select
                value={faultScenario}
                onChange={(e) => setFaultScenario(e.target.value as FaultScenario)}
                disabled={busy || !simVin}
                aria-label="Component fault scenario"
                title={FAULT_SCENARIO_HELP[faultScenario]}
                className="rounded border border-border bg-card px-1.5 py-1 font-mono text-xs text-foreground outline-none focus:border-amber-500"
              >
                {(Object.keys(FAULT_SCENARIO_LABELS) as FaultScenario[]).map((scenario) => (
                  <option key={scenario} value={scenario}>
                    {FAULT_SCENARIO_LABELS[scenario]}
                  </option>
                ))}
              </select>
              {faultScenario !== 'healthy' && (
                <select
                  value={faultIntensity}
                  onChange={(e) => setFaultIntensity(e.target.value as FaultIntensity)}
                  disabled={busy || !simVin}
                  aria-label="Fault intensity"
                  className="rounded border border-border bg-card px-1.5 py-1 font-mono text-xs text-foreground outline-none focus:border-amber-500"
                >
                  <option value="degrading">Progressive</option>
                  <option value="critical">Failure test</option>
                </select>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={applyFaultScenario}
                disabled={busy || !simVin}
                className="h-7 px-2 text-xs"
              >
                Apply + reset
              </Button>
            </div>

            {/* End-of-life banner: the vehicle died (battery dead / tire
                flat) and the sim stopped itself — a dead vehicle must not
                keep driving. Reset + Start restores it. */}
            {sim?.dead && (
              <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <span className="font-medium text-red-500">{deathMessage}</span>
                <span className="text-xs text-muted-foreground">Reset + Start to restore it</span>
              </div>
            )}

            {/* Simulator control — explicit, never auto-started (BUG-1). */}
            <Button
              variant={sim?.running ? 'destructive' : 'default'}
              size="sm"
              onClick={() => runAction(sim?.running ? 'stop' : 'start')}
              disabled={busy || !simVin}
              className="gap-1.5"
            >
              {sim?.running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {sim?.running ? 'Stop' : sim?.dead ? 'Restart' : 'Start'}
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
            {sim?.degradation && (
              <span
                className="rounded border border-border/60 bg-card/50 px-2 py-0.5 text-muted-foreground"
                title="These are the simulator presets currently used by the battery, tire and brake models."
              >
                ACTIVE PRESETS · {activeDegradation || 'healthy'}
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
            {sim?.dead && simVin
              ? `VALUES AT STOP · ${simVin}`
              : simVin && selectedVin !== simVin
              ? `LIVE VALUES · ${simVin} (simulator) · PM STATE · ${selectedVin}`
              : simVin
                ? `LIVE VALUES · ${simVin}`
                : 'SIMULATOR STOPPED — start it to see live values'}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Speed" value={Number.isFinite(speedKmh) ? `${speedKmh.toFixed(1)} km/h` : '—'} stale={frozen} />
            <Kpi
              label="Battery voltage"
              value={Number.isFinite(batteryV) ? `${batteryV.toFixed(2)} V` : '—'}
              tone={severityColor(coherent.battery.severity)}
              stale={frozen}
            />
            <Kpi
              label="Battery health"
              value={coherent.battery.score !== null ? `${coherent.battery.score}%` : '—'}
              tone={severityColor(coherent.battery.severity)}
              stale={frozen}
            />
            <Kpi
              label="Battery SoC"
              value={Number.isFinite(batterySoc) ? `${batterySoc.toFixed(0)}%` : '—'}
              tone={Number.isFinite(batterySoc) && batterySoc <= 10 ? severityColor('critical') : undefined}
              stale={frozen}
            />
            <Kpi
              label="Brake wear"
              value={`${(worstPadWearFrac * 100).toFixed(0)}%`}
              tone={severityColor(coherent.brake.severity)}
              stale={frozen}
            />
            <Kpi
              label="Tire pressure"
              value={Number.isFinite(worstTireBar) ? `${worstTireBar.toFixed(2)} bar` : '—'}
              tone={severityColor(coherent.tires.severity)}
              stale={frozen}
            />
          </div>
        </Section>

        {/* ============ SECTION: COMPONENT HEALTH ============ */}
        <Section title="Component health" meta={selectedVin ?? undefined}>
          <div className="flex flex-wrap items-center gap-3">
            <ComponentBadge label="Battery" health={coherent.battery} stale={Boolean(sim?.dead)} />
            <ComponentBadge label="Brakes" health={coherent.brake} stale={Boolean(sim?.dead)} />
            <ComponentBadge label="Tires" health={coherent.tires} stale={Boolean(sim?.dead)} />
          </div>

          {/* Live charts */}
          <FadeIn>
            <PmCharts
              samples={windowedSamples}
              health={coherent}
              idle={!live && windowedSamples.length < 2}
              stopped={!live && windowedSamples.length >= 2}
              dead={Boolean(sim?.dead)}
              timeWindowMs={CHART_WINDOW_MS}
              currentValues={{
                health: coherent.battery.score,
                voltage: Number.isFinite(batteryV) ? batteryV : null,
                brake: worstPadWearFrac * 100,
                tires: Number.isFinite(worstTireBar) ? worstTireBar : null,
              }}
              wheelHealth={{
                tires: componentSummary.tireWheels
                  .slice()
                  .sort((a, b) => a.health_score - b.health_score)
                  .map((m) => ({
                    wheel: m.wheel ?? '?',
                    score: m.health_score,
                    severity: m.severity,
                    reason: m.explanation,
                    provisional: false,
                  })),
                brake: componentSummary.brakeWheels
                  .slice()
                  .sort((a, b) => a.health_score - b.health_score)
                  .map((m) => ({
                    wheel: m.wheel ?? '?',
                    score: m.health_score,
                    severity: m.severity,
                    reason: m.explanation,
                    provisional: false,
                  })),
              }}
            />
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
              {selectedMessages.slice(0, 20).map((m, i) => {
                const friendly = friendlyAlert(m);
                return (
                  <div key={`${m.timestamp}-${m.component}-${m.wheel ?? ''}-${i}`} className="flex items-start gap-2 text-sm">
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
                    <span className="font-mono text-xs uppercase text-foreground/90">
                      {m.component}
                      {m.wheel ? ` · ${m.wheel}` : ''}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium text-foreground/90">{friendly.headline}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground/80" title={friendly.detail}>
                        {friendly.detail}
                      </span>
                    </span>
                  </div>
                );
              })}
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
  stale = false,
}: {
  label: string;
  value: string;
  tone?: string;
  stale?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-border/60 bg-card/50 px-3 py-2.5 ${stale ? 'opacity-75' : ''}`}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {stale && <span className="text-[9px] tracking-widest text-amber-500">STOPPED</span>}
      </div>
      <div
        className="mt-1 font-mono text-xl font-semibold tabular-nums"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function ComponentBadge({ label, health, stale = false }: { label: string; health: CoherentHealth; stale?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 ${stale ? 'opacity-75' : ''}`}
      title={health.reason}
    >
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase"
        style={{ color: severityColor(health.severity) }}
      >
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: severityColor(health.severity) }} />
        {health.provisional ? `~${health.severity}` : health.severity}
      </span>
    </div>
  );
}

function wheelLabel(wheel: Wheel): string {
  return ({ FL: 'front-left', FR: 'front-right', RL: 'rear-left', RR: 'rear-right' })[wheel];
}

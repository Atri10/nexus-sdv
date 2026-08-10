'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { unitForQualifier } from '@/lib/vehicle-components';
import { severityColor, type PmMessage } from '@/lib/pm-types';
import { pmSeriesForComponent, type PmComponent } from '@/components/pm/pm-health-matrix';

const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full rounded-lg" />,
});

export interface PmDrillDownProps {
  vin: string;
  component: PmComponent;
  messages: PmMessage[];
}

export interface SimulatorGroundTruth {
  vin: string;
  running: boolean;
  published: number;
  messageType?: string;
  ground_truth?: Partial<
    Record<PmComponent, { wear_fraction?: number; days_to_failure?: number; pressure_bar?: number; temp_c?: number; energy_joules?: number }>
  >;
}

/** Threshold candidates per component, keyed by the evidence field that holds them. */
const THRESHOLD_FIELDS: Record<PmComponent, string[]> = {
  battery: ['threshold_advisory', 'threshold_action'],
  brake: [],
  tires: ['threshold_slope', 'floor_bar'],
};

const THRESHOLD_LABELS: Record<string, string> = {
  threshold_advisory: 'Advisory threshold',
  threshold_action: 'Action threshold',
  threshold_slope: 'Slope threshold',
  floor_bar: 'Pressure floor',
};

function parseEvidenceNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Predicted-vs-actual for a component: the latest pm message's prediction
 * (modeled failure date from the message timestamp) against the simulator's
 * ground truth (live status reply, `ground_truth.days_to_failure`). Kept
 * honest: the simulator is the only source of ground truth here, and every
 * number carries a "simulator ground truth" label. When the simulator isn't
 * reachable (or doesn't model the component), the panel states that plainly
 * instead of inventing numbers.
 */
function PredictedVsActual({ vin, component, messages }: PmDrillDownProps) {
  const [gt, setGt] = useState<SimulatorGroundTruth | null>(null);
  const [gtError, setGtError] = useState<string | null>(null);
  // "Now" captured at each poll, so the predicted-lead math stays a pure
  // render over state (react-hooks/purity forbids Date.now() in render).
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    let ignore = false;
    fetch('/api/demo/vehicle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', vin }),
      cache: 'no-store',
    })
      .then((res) => res.json().catch(() => null))
      .then((reply: (SimulatorGroundTruth & { error?: string }) | null) => {
        if (ignore) return;
        if (!reply || reply.error) {
          setGt(null);
          setGtError(reply?.error ?? 'Simulator unreachable');
          return;
        }
        setGt(reply);
        setGtError(null);
      })
      .catch(() => {
        if (!ignore) {
          setGt(null);
          setGtError('Simulator unreachable');
        }
      })
      .finally(() => {
        if (!ignore) setNow(Date.now());
      });
    return () => {
      ignore = true;
    };
  }, [vin]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const latest = useMemo(
    () => messages.find((m) => m.vin === vin && m.component === component) ?? null,
    [messages, vin, component]
  );

  const truth = gt?.ground_truth?.[component] ?? null;

  let predictedLeadDays: number | null = null;
  if (latest && truth?.days_to_failure !== undefined) {
    const predicted = Date.parse(latest.timestamp);
    if (isFinite(predicted)) {
      // The detector's failure projection: message age + remaining modeled life.
      predictedLeadDays = (now - predicted) / 86400_000 + truth.days_to_failure;
    }
  }

  const rows: { label: string; value: string }[] = [];
  if (truth) {
    if (truth.wear_fraction !== undefined) {
      rows.push({ label: 'Wear fraction', value: `${(truth.wear_fraction * 100).toFixed(1)}%` });
    }
    if (truth.days_to_failure !== undefined) {
      rows.push({ label: 'Days to failure', value: `${truth.days_to_failure} d` });
    }
    if (truth.pressure_bar !== undefined) {
      rows.push({ label: 'Tire pressure', value: `${truth.pressure_bar.toFixed(2)} bar` });
    }
    if (truth.temp_c !== undefined) {
      rows.push({ label: 'Tire temp', value: `${truth.temp_c.toFixed(1)} °C` });
    }
    if (truth.energy_joules !== undefined) {
      rows.push({ label: 'Brake energy', value: `${truth.energy_joules.toLocaleString()} J` });
    }
  }

  return (
    <section className="rounded-lg border border-border/60 bg-card/50 p-4">
      <h3 className="mb-3 font-display text-xs font-bold tracking-[0.25em] text-muted-foreground">
        PREDICTED VS ACTUAL
      </h3>
      {gtError ? (
        <p className="text-xs text-muted-foreground">
          Simulator ground truth unavailable ({gtError}) — showing detector evidence only.
        </p>
      ) : !truth ? (
        <p className="text-xs text-muted-foreground">
          Simulator does not model {component} degradation — no ground truth to compare against.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md bg-muted/50 p-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Predicted lead
              </p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                {predictedLeadDays !== null ? `${predictedLeadDays.toFixed(1)} d` : '—'}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Detector projection: message age + modeled remaining life
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Actual days to failure
              </p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                {truth.days_to_failure !== undefined ? `${truth.days_to_failure} d` : '—'}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Simulator ground truth</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-2">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="font-mono text-xs tabular-nums text-foreground/90">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

/**
 * Drill-down for one vin+component: degradation trend chart (historical +
 * live telemetry for the component's sensors, threshold overlay from the
 * latest message's evidence), the detector's evidence as a labeled math
 * panel, and predicted-vs-actual against the simulator's ground truth.
 */
export function PmDrillDown({ vin, component, messages }: PmDrillDownProps) {
  const theme = useChartTheme();
  const { series, loading, error } = useTelemetryData({ vin, range: '7d' });

  // Latest message for this vin+component (messages are newest-first).
  const latest = useMemo(
    () => messages.find((m) => m.vin === vin && m.component === component) ?? null,
    [messages, vin, component]
  );

  // The component's sensors (battery.voltage, TIRE_PRESSURE, ...) — filtered
  // with the PM sensor map /pm owns (brake and tires are not demo components).
  const componentSeries = useMemo(
    () => pmSeriesForComponent(series, component).filter((s) => s.points.some((p) => p.y != null)),
    [series, component]
  );

  // Threshold overlay: pull the threshold numbers out of the latest message's
  // evidence (e.g. threshold_advisory 12.4 V for battery, floor_bar 1.8 bar
  // for tires). Applied to every sensor series in the trend chart.
  const thresholds = useMemo(() => {
    const out: number[] = [];
    if (!latest) return out;
    for (const field of THRESHOLD_FIELDS[component]) {
      const n = parseEvidenceNumber(latest.evidence[field]);
      if (n !== null) out.push(n);
    }
    return out;
  }, [latest, component]);

  const evidenceRows = useMemo(
    () =>
      latest
        ? Object.entries(latest.evidence).map(([key, value]) => ({
            key,
            value,
            label: THRESHOLD_LABELS[key] ?? null,
          }))
        : [],
    [latest]
  );

  // Threshold line overlay: one flat series per threshold value from the
  // latest message's evidence, spanning the trend's time range, drawn in the
  // action color so the crossing is visible next to the telemetry lines.
  const thresholdSeries = useMemo(() => {
    if (thresholds.length === 0 || componentSeries.length === 0) return [];
    let minX = Infinity;
    let maxX = -Infinity;
    for (const s of componentSeries) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
    }
    if (!isFinite(minX) || !isFinite(maxX)) return [];
    return thresholds.map((t, i) => ({
      vin,
      column: `${component}.threshold`,
      key: `${vin}|${component}|threshold-${i}`,
      label: `threshold ${t}`,
      color: severityColor('action'),
      points: [
        { x: minX, y: t },
        { x: maxX, y: t },
      ],
    }));
  }, [thresholds, componentSeries, vin, component]);

  const trendSeries = useMemo(
    () => [...componentSeries, ...thresholdSeries],
    [componentSeries, thresholdSeries]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-semibold text-foreground">{vin}</h3>
          <Badge className="font-mono text-[10px] uppercase tracking-wider">{component}</Badge>
          {latest && (
            <Badge
              className="font-mono text-[10px] uppercase tracking-wider"
              style={{
                backgroundColor: `${severityColor(latest.severity)}26`,
                color: severityColor(latest.severity),
              }}
            >
              score {latest.health_score}
            </Badge>
          )}
        </div>
        <span className="font-mono text-[11px] tracking-wider text-muted-foreground">
          DEGRADATION TREND · 7D
        </span>
      </div>

      {error ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Telemetry unavailable ({error}) — trend chart needs the telemetry service.
        </div>
      ) : loading ? (
        <Skeleton className="h-72 w-full rounded-lg" />
      ) : componentSeries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No {component} telemetry in the last 7 days for {vin} — enable the component on the
          simulator to populate the trend.
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card/50 p-4">
          <div className="h-72">
            <TelemetryChart
              vehicleId={vin}
              series={trendSeries}
              type="line"
              axisMode="single"
              hidden={new Set()}
              theme={theme}
              resetZoomToken={0}
              units={Object.fromEntries(
                componentSeries
                  .map((s) => {
                    const colon = s.column.indexOf(':');
                    const q = colon > -1 ? s.column.slice(colon + 1) : s.column;
                    return [s.key, unitForQualifier(q)];
                  })
                  .filter(([, u]) => u !== undefined)
              )}
              height="100%"
            />
          </div>
          {thresholds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {thresholds.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: severityColor('action') }} aria-hidden="true" />
                  threshold {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <section className="rounded-lg border border-border/60 bg-card/50 p-4">
        <h3 className="mb-3 font-display text-xs font-bold tracking-[0.25em] text-muted-foreground">
          DETECTOR MATH
        </h3>
        {latest ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {evidenceRows.map(({ key, value, label }) => (
              <div key={key} className="flex items-baseline justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">{label ?? key}</span>
                <code className="font-mono text-xs tabular-nums text-foreground/90">{value}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No {component} message for {vin} yet — the detector publishes once it has enough
            telemetry (30 days for the battery slope, 14 compensated tire samples).
          </p>
        )}
        {latest && (
          <p className="mt-3 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            {latest.explanation}
          </p>
        )}
      </section>

      <PredictedVsActual vin={vin} component={component} messages={messages} />
    </div>
  );
}

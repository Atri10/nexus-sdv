'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Maximize2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TelemetryChart from '@/components/telemetry-chart/TelemetryChart';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { CoherentHealth, Wheel } from '@/lib/pm-health';
import { WHEELS } from '@/lib/pm-health';
import type { PmMessage } from '@/lib/pm-types';

/** One sample of the live values driving the PM charts. */
export interface PmSample {
  t: number; // epoch ms
  /** Explicit missing-data marker used to break lines across simulator stops. */
  gap?: boolean;
  health?: number | null;
  voltage?: number | null;
  brakeWear?: number | null;
  tirePressure?: number | null;
  /** Per-wheel tire pressures (bar) at this sample, when ground truth has them. */
  tirePressures?: Partial<Record<Wheel, number | null>>;
  /** Per-pad brake wear fractions (0..1) at this sample, when ground truth has them. */
  brakeWears?: Partial<Record<Wheel, number | null>>;
}

const WHEEL_SHADES: Record<Wheel, string> = {
  FL: '#A855F7',
  FR: '#C084FC',
  RL: '#7C3AED',
  RR: '#D946EF',
};
const PAD_SHADES: Record<Wheel, string> = {
  FL: '#F97316',
  FR: '#FB923C',
  RL: '#EA580C',
  RR: '#F43F5E',
};

const COLORS = {
  health: '#22C55E',
  voltage: '#3B82F6',
  brake: '#F97316',
  tires: '#A855F7',
};

const HEALTH_BAND_COLOR: Record<CoherentHealth['severity'], string> = {
  healthy: '#22C55E',
  advisory: '#F59E0B',
  action: '#F97316',
  critical: '#EF4444',
};

const HEALTH_BAND_LABEL: Record<CoherentHealth['severity'], string> = {
  healthy: 'HEALTHY',
  advisory: 'ADVISORY',
  action: 'ACTION',
  critical: 'CRITICAL',
};

function autoYRange(series: ChartSeries[], unit: string): { min: number; max: number } | undefined {
  const values = series.flatMap((entry) => entry.points.map((point) => point.y)).filter(
    (value): value is number => value !== null && Number.isFinite(value)
  );
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const minimumPadding = unit === '%' ? 5 : unit === 'V' ? 0.05 : unit === 'bar' ? 0.05 : 1;
  const padding = Math.max(span * 0.15, minimumPadding);
  return { min: min - padding, max: max + padding };
}

interface PmChartCardProps {
  title: string;
  unit: string;
  /** One series per wheel/pad (4 lines) or a single aggregate series. */
  series: ChartSeries[];
  health: CoherentHealth;
  /** Fixed visible x-axis window (ms), stable from startup through death. */
  timeWindowMs: number;
  /** True when the simulator is not streaming (idle). */
  idle: boolean;
  yRange?: { min?: number; max?: number };
  color: string;
  /** Per-wheel/pad rows for the expand dialog (worst-first). */
  wheelEntries?: WheelHealthEntry[];
  /** Worst-wheel label shown in the card summary (e.g. 'FL flat'). */
  worstWheelLabel?: string;
  /** Current value from the same live frame as the page KPI. */
  currentValue?: number | null;
  stopped?: boolean;
  dead?: boolean;
}

/**
 * One PM live chart card: severity band + current value + trend in the
 * header, the sparkline below, and a click-to-expand affordance that opens
 * the same signal full-size with zoom. Idle (simulator stopped / no data)
 * renders a "start to see live data" placeholder instead of a flat line —
 * a stopped sim must never auto-draw a flatline that reads as real data.
 */
function PmChartCard({ title, unit, series, health, timeWindowMs, idle, yRange, color, wheelEntries, worstWheelLabel, currentValue, stopped = false, dead = false }: PmChartCardProps) {
  const theme = useChartTheme();
  const [expanded, setExpanded] = useState(false);

  // The LAST series is the primary (worst-wheel/aggregate) for the header
  // current-value + trend; the per-wheel series are drawn beneath it.
  const primary = series[series.length - 1];
  const pts = primary?.points ?? [];
  const numericPoints = pts.filter((point) => point.y !== null);
  const last = numericPoints.length ? numericPoints[numericPoints.length - 1].y : null;
  const displayValue = currentValue !== undefined ? currentValue : last;
  const prev = numericPoints.length > 1 ? numericPoints[numericPoints.length - 2].y : null;
  const trend =
    last === null || prev === null || last === prev
      ? null
      : (last as number) > (prev as number)
        ? '▲'
        : '▼';
  const bandColor = HEALTH_BAND_COLOR[health.severity];
  const bandLabel = HEALTH_BAND_LABEL[health.severity];

  // Idle = no live samples. Don't draw a flat line — show the placeholder.
  const showChart = !idle && numericPoints.length >= 2;

  return (
    <>
      <Card
        className="group relative cursor-pointer overflow-hidden transition-colors hover:border-border"
        onClick={() => setExpanded(true)}
        role="button"
        tabIndex={0}
        aria-label={`Expand ${title} chart`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(true);
          }
        }}
      >
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 pb-1">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          <div className="flex items-baseline gap-2 font-mono text-sm">
            {worstWheelLabel && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ backgroundColor: `${bandColor}22`, color: bandColor }}>
                {worstWheelLabel}
              </span>
            )}
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{ backgroundColor: `${bandColor}22`, color: bandColor }}
              title={health.reason}
            >
              {health.provisional ? `~${bandLabel}` : bandLabel}
            </span>
            <span className="tabular-nums" style={{ color: bandColor }}>
              {displayValue !== null && displayValue !== undefined ? `${Number(displayValue).toFixed(unit === '%' ? 0 : 2)} ${unit}` : '—'}
            </span>
            {trend && (
              <span className={`text-xs ${trend === '▲' ? 'text-emerald-500' : 'text-red-500'}`}>
                {trend}
              </span>
            )}
            <Maximize2 className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </CardHeader>
        <CardContent className="pt-1">
          {stopped && (
            <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-amber-600">
              {dead ? 'Vehicle stopped — final recorded history' : 'Simulator stopped — final recorded history'}
            </div>
          )}
          {showChart ? (
            <>
              <div className="h-36">
                <TelemetryChart
                  vehicleId="pm"
                  series={series}
                  type="line"
                  axisMode="single"
                  hidden={new Set()}
                  theme={theme}
                  resetZoomToken={0}
                  zoomEnabled={false}
                  units={Object.fromEntries(series.map((s) => [s.key, unit]))}
                  animated={false}
                  height="100%"
                  yRange={yRange}
                  timeWindowMs={timeWindowMs}
                  spanGaps={false}
                />
              </div>
              {series.length > 1 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {series.map((s) => (
                    <span key={s.key} className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                        aria-hidden="true"
                      />
                      {s.label.replace(/^Tire |^Brake /, '')}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex h-36 flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border/50 text-center">
              {idle ? (
                <>
                  <span className="font-mono text-sm text-muted-foreground">Simulator idle</span>
                  <span className="text-xs text-muted-foreground/70">
                    Start the simulator to see live {title.toLowerCase()}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-mono text-sm text-muted-foreground">Collecting data…</span>
                  <span className="text-xs text-muted-foreground/70">
                    Waiting for the first samples
                  </span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
              {title}
              <span className="text-muted-foreground">· {unit}</span>
              <span
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{ backgroundColor: `${bandColor}22`, color: bandColor }}
                title={health.reason}
              >
                {health.provisional ? `~${bandLabel}` : bandLabel} · {health.score}
              </span>
              {displayValue !== null && displayValue !== undefined && (
                <span className="font-semibold tabular-nums">
                  {Number(displayValue).toFixed(unit === '%' ? 0 : 2)} {unit}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="h-[400px]">
            {showChart ? (
              <TelemetryChart
                vehicleId="pm"
                series={series}
                type="line"
                axisMode="single"
                hidden={new Set()}
                theme={theme}
                resetZoomToken={0}
                units={Object.fromEntries(series.map((s) => [s.key, unit]))}
                height="100%"
                yRange={yRange}
                timeWindowMs={timeWindowMs}
                spanGaps={false}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border/50 text-center">
                <span className="font-mono text-sm text-muted-foreground">
                  {idle ? 'Simulator idle — start to see live data' : 'Collecting data…'}
                </span>
              </div>
            )}
          </div>
          {health.reason && (
            <p className="text-xs text-muted-foreground">{health.reason}</p>
          )}
          {wheelEntries && wheelEntries.length > 0 && (
            <div className="space-y-1.5 border-t border-border/60 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {unit === '%' ? 'Per-pad' : 'Per-wheel'}
              </div>
              {wheelEntries.map((e) => {
                const c = HEALTH_BAND_COLOR[e.severity];
                return (
                  <div
                    key={e.wheel}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-sm"
                  >
                    <span className="font-mono text-xs font-semibold uppercase tracking-wider">
                      {e.wheel}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ backgroundColor: `${c}22`, color: c }}
                    >
                      {e.provisional ? `~${e.severity}` : e.severity} · {e.score}
                    </span>
                    <span className="text-xs text-muted-foreground">{e.reason}</span>
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One per-wheel/pad PM entry shown in the expand dialog. */
export interface WheelHealthEntry {
  wheel: string;
  score: number;
  severity: PmMessage['severity'];
  reason: string;
  provisional: boolean;
}

export interface PmChartsProps {
  samples: PmSample[];
  /** Fixed x-axis window used by every card. */
  timeWindowMs: number;
  /** Per-component coherent health (merged PM + live). */
  health: Record<string, CoherentHealth>;
  /** True when the simulator is stopped / not streaming. */
  idle: boolean;
  /** A stopped simulator with retained samples should keep rendering them. */
  stopped?: boolean;
  /** Distinguishes end-of-life from an ordinary manual stop. */
  dead?: boolean;
  /**
   * Per-wheel/pad PM entries (worst-first), keyed by component. The expand
   * dialog lists these rows; the tires/brake card summary shows the worst
   * one. Optional — legacy callers render without per-wheel detail.
   */
  wheelHealth?: Partial<Record<'tires' | 'brake', WheelHealthEntry[]>>;
  /** Current values from the same live frame as the page KPI row. */
  currentValues?: Partial<Record<'health' | 'voltage' | 'brake' | 'tires', number | null>>;
}

/**
 * Four live PM charts with a ~10-minute client-side rolling buffer. Each
 * card shows the current value with a coherent severity band, a trend arrow,
 * and a click-to-expand detail view. Idle (simulator stopped) renders
 * placeholders instead of flatlines. Y-ranges are death-state aware so the
 * degradation climax stays on-plot.
 */
export function PmCharts({ samples, timeWindowMs, health, idle, stopped = false, dead = false, wheelHealth, currentValues }: PmChartsProps) {
  const series = useMemo<Record<string, ChartSeries[]>>(() => {
    const make = (
      key: string,
      label: string,
      color: string,
      pick: (s: PmSample) => number | null | undefined
    ): ChartSeries => ({
      vin: 'pm',
      column: key,
      key,
      label,
      color,
      stepped: key === 'health',
      points: samples.map((s) => ({ x: s.t, y: pick(s) ?? null })),
    });
    // Per-wheel/pad series: one line per corner so asymmetric degradation is
    // visible in the chart itself (FL dying while FR holds 2.3 bar). The
    // aggregate (worst-wheel) series is appended LAST so the card header's
    // current-value/trend reads the worst corner, matching the badge.
    const wheelSeries = (
      base: string,
      labelBase: string,
      colors: Record<Wheel, string>,
      pick: (s: PmSample, w: Wheel) => number | null | undefined,
      scale: (v: number) => number
    ): ChartSeries[] => {
      const out: ChartSeries[] = [];
      for (const w of WHEELS) {
        out.push(
          make(`${base}.${w}`, `${labelBase} ${w}`, colors[w], (s) => {
            const v = pick(s, w);
            return v === null || v === undefined ? null : scale(v);
          })
        );
      }
      return out;
    };
    const tireWheel = wheelSeries('tires', 'Tire', WHEEL_SHADES, (s, w) => s.tirePressures?.[w], (v) => v);
    const padWheel = wheelSeries('brake', 'Brake', PAD_SHADES, (s, w) => s.brakeWears?.[w], (v) => v * 100);
    return {
      health: [make('health', 'Battery health', COLORS.health, (s) => s.health)],
      voltage: [make('voltage', 'Battery voltage', COLORS.voltage, (s) => s.voltage)],
      brake: [
        ...padWheel,
        make('brake', 'Brake wear', COLORS.brake, (s) =>
          s.brakeWear === null || s.brakeWear === undefined ? null : s.brakeWear * 100
        ),
      ],
      tires: [
        ...tireWheel,
        make('tires', 'Tire pressure', COLORS.tires, (s) => s.tirePressure),
      ],
    };
  }, [samples]);

  const b = health['battery'] ?? { score: 100, severity: 'healthy', provisional: true, reason: '' };
  const br = health['brake'] ?? { score: 100, severity: 'healthy', provisional: true, reason: '' };
  const t = health['tires'] ?? { score: 100, severity: 'healthy', provisional: true, reason: '' };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PmChartCard
        title="Battery health"
        unit="%"
        series={series.health}
        health={b}
        timeWindowMs={timeWindowMs}
        idle={idle}
        stopped={stopped}
        dead={dead}
        yRange={autoYRange(series.health, '%')}
        color={COLORS.health}
        currentValue={currentValues?.health}
      />
      <PmChartCard
        title="Battery voltage"
        unit="V"
        series={series.voltage}
        health={b}
        timeWindowMs={timeWindowMs}
        idle={idle}
        stopped={stopped}
        dead={dead}
        yRange={autoYRange(series.voltage, 'V')}
        color={COLORS.voltage}
        currentValue={currentValues?.voltage}
      />
      <PmChartCard
        title="Brake wear"
        unit="%"
        series={series.brake}
        health={br}
        timeWindowMs={timeWindowMs}
        idle={idle}
        stopped={stopped}
        dead={dead}
        yRange={autoYRange(series.brake, '%')}
        color={COLORS.brake}
        currentValue={currentValues?.brake}
        wheelEntries={wheelHealth?.brake}
        worstWheelLabel={
          wheelHealth?.brake?.[0]
            ? `${wheelHealth.brake[0].wheel} · ${wheelHealth.brake[0].score}%`
            : undefined
        }
      />
      <PmChartCard
        title="Tire pressure"
        unit="bar"
        series={series.tires}
        health={t}
        timeWindowMs={timeWindowMs}
        idle={idle}
        stopped={stopped}
        dead={dead}
        yRange={autoYRange(series.tires, 'bar')}
        color={COLORS.tires}
        currentValue={currentValues?.tires}
        wheelEntries={wheelHealth?.tires}
        worstWheelLabel={
          wheelHealth?.tires?.[0]
            ? `${wheelHealth.tires[0].wheel} · ${wheelHealth.tires[0].score}%`
            : undefined
        }
      />
    </div>
  );
}

// Keep a stable default export for dynamic() consumers.
export default PmCharts;

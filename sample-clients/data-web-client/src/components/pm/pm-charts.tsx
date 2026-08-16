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

interface PmChartCardProps {
  title: string;
  unit: string;
  /** One series per wheel/pad (4 lines) or a single aggregate series. */
  series: ChartSeries[];
  health: CoherentHealth;
  /** Window span (ms) for readable time ticks. */
  windowMs: number;
  /** True when the simulator is not streaming (idle). */
  idle: boolean;
  yRange: { min?: number; max?: number };
  color: string;
  /** Per-wheel/pad rows for the expand dialog (worst-first). */
  wheelEntries?: WheelHealthEntry[];
  /** Worst-wheel label shown in the card summary (e.g. 'FL flat'). */
  worstWheelLabel?: string;
}

/**
 * One PM live chart card: severity band + current value + trend in the
 * header, the sparkline below, and a click-to-expand affordance that opens
 * the same signal full-size with zoom. Idle (simulator stopped / no data)
 * renders a "start to see live data" placeholder instead of a flat line —
 * a stopped sim must never auto-draw a flatline that reads as real data.
 */
function PmChartCard({ title, unit, series, health, windowMs, idle, yRange, color, wheelEntries, worstWheelLabel }: PmChartCardProps) {
  const theme = useChartTheme();
  const [expanded, setExpanded] = useState(false);

  // The LAST series is the primary (worst-wheel/aggregate) for the header
  // current-value + trend; the per-wheel series are drawn beneath it.
  const primary = series[series.length - 1];
  const pts = primary?.points ?? [];
  const last = pts.length ? pts[pts.length - 1].y : null;
  const prev = pts.length > 1 ? pts[pts.length - 2].y : null;
  const trend =
    last === null || prev === null || last === prev
      ? null
      : (last as number) > (prev as number)
        ? '▲'
        : '▼';
  const bandColor = HEALTH_BAND_COLOR[health.severity];
  const bandLabel = HEALTH_BAND_LABEL[health.severity];

  // Idle = no live samples. Don't draw a flat line — show the placeholder.
  const showChart = !idle && pts.length >= 2;

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
              {last !== null ? `${Number(last).toFixed(unit === '%' ? 0 : 2)} ${unit}` : '—'}
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
          {showChart ? (
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
                timeWindowMs={windowMs}
              />
            </div>
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
              {last !== null && (
                <span className="font-semibold tabular-nums">
                  {Number(last).toFixed(unit === '%' ? 0 : 2)} {unit}
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
                timeWindowMs={windowMs}
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
  /** Per-component coherent health (merged PM + live). */
  health: Record<string, CoherentHealth>;
  /** True when the simulator is stopped / not streaming. */
  idle: boolean;
  /**
   * Per-wheel/pad PM entries (worst-first), keyed by component. The expand
   * dialog lists these rows; the tires/brake card summary shows the worst
   * one. Optional — legacy callers render without per-wheel detail.
   */
  wheelHealth?: Partial<Record<'tires' | 'brake', WheelHealthEntry[]>>;
}

/**
 * Four live PM charts with a ~10-minute client-side rolling buffer. Each
 * card shows the current value with a coherent severity band, a trend arrow,
 * and a click-to-expand detail view. Idle (simulator stopped) renders
 * placeholders instead of flatlines. Y-ranges are death-state aware so the
 * degradation climax stays on-plot.
 */
export function PmCharts({ samples, health, idle, wheelHealth }: PmChartsProps) {
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
      points: samples.map((s) => ({ x: s.t, y: pick(s) ?? null })).filter((p) => p.y !== null),
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

  // Window span for readable time ticks (HH:mm:ss for short windows).
  const windowMs = useMemo(() => {
    if (samples.length < 2) return 0;
    return samples[samples.length - 1].t - samples[0].t;
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
        windowMs={windowMs}
        idle={idle}
        yRange={{ min: 0, max: 100 }}
        color={COLORS.health}
      />
      <PmChartCard
        title="Battery voltage"
        unit="V"
        series={series.voltage}
        health={b}
        windowMs={windowMs}
        idle={idle}
        yRange={{ min: 10.4, max: 12.8 }}
        color={COLORS.voltage}
      />
      <PmChartCard
        title="Brake wear"
        unit="%"
        series={series.brake}
        health={br}
        windowMs={windowMs}
        idle={idle}
        yRange={{ min: 0, max: 100 }}
        color={COLORS.brake}
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
        windowMs={windowMs}
        idle={idle}
        yRange={{ min: 0.9, max: 2.5 }}
        color={COLORS.tires}
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

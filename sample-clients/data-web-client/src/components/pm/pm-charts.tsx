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
import type { CoherentHealth } from '@/lib/pm-health';

/** One sample of the live values driving the PM charts. */
export interface PmSample {
  t: number; // epoch ms
  health?: number | null;
  voltage?: number | null;
  brakeWear?: number | null;
  tirePressure?: number | null;
}

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
  series: ChartSeries;
  health: CoherentHealth;
  /** Window span (ms) for readable time ticks. */
  windowMs: number;
  /** True when the simulator is not streaming (idle). */
  idle: boolean;
  yRange: { min?: number; max?: number };
  color: string;
}

/**
 * One PM live chart card: severity band + current value + trend in the
 * header, the sparkline below, and a click-to-expand affordance that opens
 * the same signal full-size with zoom. Idle (simulator stopped / no data)
 * renders a "start to see live data" placeholder instead of a flat line —
 * a stopped sim must never auto-draw a flatline that reads as real data.
 */
function PmChartCard({ title, unit, series, health, windowMs, idle, yRange, color }: PmChartCardProps) {
  const theme = useChartTheme();
  const [expanded, setExpanded] = useState(false);

  const pts = series.points;
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
                series={[series]}
                type="line"
                axisMode="single"
                hidden={new Set()}
                theme={theme}
                resetZoomToken={0}
                zoomEnabled={false}
                units={{ [series.key]: unit }}
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
                series={[series]}
                type="line"
                axisMode="single"
                hidden={new Set()}
                theme={theme}
                resetZoomToken={0}
                units={{ [series.key]: unit }}
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
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface PmChartsProps {
  samples: PmSample[];
  /** Per-component coherent health (merged PM + live). */
  health: Record<string, CoherentHealth>;
  /** True when the simulator is stopped / not streaming. */
  idle: boolean;
}

/**
 * Four live PM charts with a ~10-minute client-side rolling buffer. Each
 * card shows the current value with a coherent severity band, a trend arrow,
 * and a click-to-expand detail view. Idle (simulator stopped) renders
 * placeholders instead of flatlines. Y-ranges are death-state aware so the
 * degradation climax stays on-plot.
 */
export function PmCharts({ samples, health, idle }: PmChartsProps) {
  const series = useMemo<Record<string, ChartSeries>>(() => {
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
    return {
      health: make('health', 'Battery health', COLORS.health, (s) => s.health),
      voltage: make('voltage', 'Battery voltage', COLORS.voltage, (s) => s.voltage),
      brake: make('brake', 'Brake wear', COLORS.brake, (s) =>
        s.brakeWear === null || s.brakeWear === undefined ? null : s.brakeWear * 100
      ),
      tires: make('tires', 'Tire pressure', COLORS.tires, (s) => s.tirePressure),
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
      />
    </div>
  );
}

// Keep a stable default export for dynamic() consumers.
export default PmCharts;

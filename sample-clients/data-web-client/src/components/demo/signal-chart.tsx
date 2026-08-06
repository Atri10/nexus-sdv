'use client';
import { memo, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { Maximize2 } from 'lucide-react';
import { formatValue } from '@/lib/telemetry-chart-utils';
import { stableAxisRange } from '@/lib/chart-range';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-48 w-full rounded-lg" />,
});

export interface SignalChartProps {
  series: ChartSeries;
  unit?: string;
  /** Component disabled (or unknown) — chart froze; dim the card. */
  paused: boolean;
  theme: ChartThemeColors;
  onExpand: () => void;
}

function latestPoint(series: ChartSeries): number | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const p = series.points[i];
    if (p.y != null) return p.y;
  }
  return null;
}

function latestRaw(series: ChartSeries): string | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const p = series.points[i];
    if (p.raw != null) return String(p.raw);
  }
  return null;
}

/** Last raw values (oldest → newest) for non-numeric signal history. */
function rawHistory(series: ChartSeries, count: number): string[] {
  const out: string[] = [];
  for (let i = series.points.length - 1; i >= 0 && out.length < count; i--) {
    const p = series.points[i];
    if (p.raw != null) out.unshift(String(p.raw));
  }
  return out;
}

/**
 * One real-time chart card per telemetry signal. Memoized on the series
 * identity: series objects are only replaced when new points arrive, so a
 * paused signal's card skips re-renders entirely while others keep updating.
 * The y-axis uses a stable full-history window (no per-tick rescaling, so
 * live lines don't jump), and wheel/drag zoom stays disabled — the expanded
 * detail dialog is where zoom belongs. Non-numeric signals (static strings)
 * render a live value card instead of a chart — decided from the data.
 */
export const SignalChart = memo(function SignalChart({ series, unit, paused, theme, onExpand }: SignalChartProps) {
  const numeric = series.points.some((p) => p.y != null);
  const latest = latestPoint(series);
  const raw = latestRaw(series);
  const history = rawHistory(series, 8);
  const yRange = useMemo(() => stableAxisRange(series.points), [series]);
  return (
    <div
      className={`group relative flex flex-col rounded-lg border bg-card p-3 transition-colors hover:border-border ${
        paused ? 'border-border/40 opacity-70' : 'border-border/60'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: series.color }}
            aria-hidden="true"
          />
          <span className="truncate font-mono text-xs font-medium text-foreground">{series.label}</span>
          {unit && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {unit}
            </span>
          )}
          {!paused && (
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
          )}
          {paused && (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              Paused
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-sm font-semibold tabular-nums">
            {latest != null ? `${formatValue(latest)}${unit ? ` ${unit}` : ''}` : '—'}
          </span>
          <button
            type="button"
            aria-label={`Expand ${series.label} chart`}
            onClick={onExpand}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="relative mt-2 h-48">
        {numeric ? (
          <TelemetryChart
            vehicleId={series.vin}
            series={[series]}
            type="line"
            axisMode="single"
            hidden={new Set()}
            theme={theme}
            resetZoomToken={0}
            units={unit ? { [series.key]: unit } : {}}
            zoomEnabled={false}
            animated={false}
            yRange={yRange ?? undefined}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums">{raw ?? '—'}</span>
            {history.length > 0 && (
              <div className="flex max-w-full flex-wrap justify-center gap-1 px-2">
                {history.map((v, i) => (
                  <span
                    key={i}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {v}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

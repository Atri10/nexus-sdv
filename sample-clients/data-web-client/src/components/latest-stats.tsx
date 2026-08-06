'use client';

import { Card } from '@/components/ui/card';
import { columnQualifier, formatValue } from '@/lib/telemetry-chart-utils';
import { latestValues } from '@/lib/telemetry-table';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import { unitForQualifier } from '@/lib/vehicle-components';

/**
 * KPI strip: latest value per visible series, shown as large mono text with
 * the series color, a pulsing live indicator, a mini trend sparkline and a
 * ▲/▼ delta vs the previous value. Units come from the shared component
 * metadata via unitForQualifier. Empty when no series are visible — the
 * chart's own StateView covers loading/empty/error.
 */

/** formatValue with a single decimal place for delta chips. */
function formatDelta(v: number): string {
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

/** Mini trend line: history normalized into the 60×16 viewBox with 10% y padding. */
function Sparkline({ points, color }: { points: { x: number; y: number }[]; color: string }) {
  if (points.length < 2) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // 10% padding on the value axis so the line never touches the top/bottom
  // edges; a flat series gets a symmetric band instead of a degenerate range.
  const yRange = maxY - minY;
  const yPad = yRange === 0 ? Math.max(Math.abs(maxY) * 0.1, 1) : yRange * 0.1;
  const bottom = minY - yPad;
  const height = maxY + yPad - bottom;
  const xSpan = maxX - minX || 1;
  const W = 60;
  const H = 16;

  const pointsAttr = points
    .map((p) => `${((p.x - minX) / xSpan) * W},${H - ((p.y - bottom) / height) * H}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-4 w-15" aria-hidden="true" preserveAspectRatio="none">
      <polyline
        points={pointsAttr}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function LatestStats(props: { series: ChartSeries[]; hidden: Set<string> }) {
  const visible = props.series.filter((s) => !props.hidden.has(s.key));
  const stats = latestValues(visible);
  if (stats.length === 0) return null;

  const units = new Map(
    visible.map((s) => [s.key, unitForQualifier(columnQualifier(s.column))]),
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((s) => {
        const unit = units.get(s.key);
        const delta = s.value != null && s.previous != null ? s.value - s.previous : null;
        const up = delta != null && delta >= 0;
        return (
          <Card key={s.key} className="p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden="true"
              />
              <span className="truncate">{s.label}</span>
              {s.timestamp != null && (
                <span className="relative ml-auto flex h-2 w-2 shrink-0" title="Live">
                  <span
                    className="live-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                    style={{ backgroundColor: s.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="relative inline-flex h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                    aria-hidden="true"
                  />
                  <span className="sr-only">live</span>
                </span>
              )}
            </div>
            <p
              className="mt-1 truncate font-mono text-lg font-semibold tabular-nums"
              style={{ color: s.color }}
            >
              {s.value != null ? (
                <>
                  {formatValue(s.value)}
                  {unit && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>
                  )}
                </>
              ) : (
                '—'
              )}
            </p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <Sparkline points={s.history} color={s.color} />
              {delta != null && (
                <p
                  className={`shrink-0 font-mono text-xs font-medium tabular-nums ${
                    up ? 'text-emerald-500' : 'text-red-500'
                  }`}
                  aria-label={up ? 'up from previous' : 'down from previous'}
                >
                  <span aria-hidden="true">{up ? '▲' : '▼'}</span> {formatDelta(Math.abs(delta))}
                  {unit ? ` ${unit}` : ''}
                </p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

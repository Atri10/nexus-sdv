'use client';

import { Card } from '@/components/ui/card';
import { formatValue } from '@/lib/telemetry-chart-utils';
import { latestValues } from '@/lib/telemetry-table';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

/**
 * KPI strip: latest value per visible series, shown as large mono text with
 * the series color and a pulsing live indicator. Empty when no series are
 * visible — the chart's own StateView covers loading/empty/error.
 */
export function LatestStats(props: { series: ChartSeries[]; hidden: Set<string> }) {
  const stats = latestValues(props.series.filter((s) => !props.hidden.has(s.key)));
  if (stats.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((s) => (
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
            {s.value != null ? formatValue(s.value) : '—'}
          </p>
        </Card>
      ))}
    </div>
  );
}

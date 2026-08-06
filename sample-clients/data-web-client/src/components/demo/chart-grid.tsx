'use client';
import { Fragment, useMemo, useState } from 'react';
import { SignalChart } from '@/components/demo/signal-chart';
import { ChartDetailDialog } from '@/components/demo/chart-detail-dialog';
import { componentsForSeries, qualifierOf, unitForSignal } from '@/lib/telemetry-discovery';
import type { ComponentStatus } from '@/lib/demo-control';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

export interface ChartGridProps {
  series: ChartSeries[];
  components: ComponentStatus[] | null;
  hidden: Set<string>;
  theme: ChartThemeColors;
  onToggleSeries: (key: string) => void;
}

/**
 * Responsive grid of one real-time chart per discovered signal, grouped by
 * the component that owns it. Clicking any chart opens a full-size detail
 * dialog. New signals appear automatically — nothing here is hardcoded.
 */
export function ChartGrid({ series, components, hidden, theme, onToggleSeries }: ChartGridProps) {
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const groups = useMemo(() => componentsForSeries(components, series), [components, series]);
  const order = useMemo(() => {
    const ids = (components ?? []).map((c) => c.id).filter((id) => groups.has(id));
    if (groups.has('unassigned')) ids.push('unassigned');
    return ids;
  }, [components, groups]);

  const detailSeries = detailKey ? series.find((s) => s.key === detailKey) : undefined;

  return (
    <div className="space-y-6">
      {order.map((componentId) => {
        const label =
          componentId === 'unassigned'
            ? 'Other signals'
            : components?.find((c) => c.id === componentId)?.label ?? componentId;
        const groupSeries = groups.get(componentId) ?? [];
        const visible = groupSeries.filter((s) => !hidden.has(s.key));
        const enabled = componentId === 'unassigned' ? true : (components?.find((c) => c.id === componentId)?.enabled ?? true);
        return (
          <Fragment key={componentId}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold tracking-wide text-foreground">{label}</h3>
              <button
                type="button"
                onClick={() => groupSeries.forEach((s) => onToggleSeries(s.key))}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {visible.length === groupSeries.length ? 'Hide all' : 'Show all'}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {groupSeries.map((s) => (
                <SignalChart
                  key={s.key}
                  series={s}
                  unit={unitForSignal(components, qualifierOf(s.column))}
                  paused={!enabled}
                  theme={theme}
                  onExpand={() => setDetailKey(s.key)}
                />
              ))}
            </div>
          </Fragment>
        );
      })}
      <ChartDetailDialog
        open={detailKey !== null}
        onOpenChange={(open) => {
          if (!open) setDetailKey(null);
        }}
        series={detailSeries}
        unit={detailSeries ? unitForSignal(components, qualifierOf(detailSeries.column)) : undefined}
        theme={theme}
      />
    </div>
  );
}

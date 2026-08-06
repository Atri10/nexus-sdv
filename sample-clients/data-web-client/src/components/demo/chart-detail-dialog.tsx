'use client';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatValue } from '@/lib/telemetry-chart-utils';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full rounded-lg" />,
});

export interface ChartDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  series?: ChartSeries;
  unit?: string;
  theme: ChartThemeColors;
}

/** Full-size detailed view of one telemetry signal (zoom + axes). */
export function ChartDetailDialog({ open, onOpenChange, series, unit, theme }: ChartDetailDialogProps) {
  const last = series ? [...series.points].reverse().find((p) => p.y != null) : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: series?.color }}
              aria-hidden="true"
            />
            {series?.label}
            {unit ? ` · ${unit}` : ''}
            {last?.y != null && (
              <span className="ml-auto font-semibold tabular-nums">
                {formatValue(last.y)}
                {unit ? ` ${unit}` : ''}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="h-[400px]">
          {series && (
            <TelemetryChart
              vehicleId={series.vin}
              series={[series]}
              type="line"
              axisMode="single"
              hidden={new Set()}
              theme={theme}
              resetZoomToken={0}
              units={unit ? { [series.key]: unit } : {}}
              height="100%"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

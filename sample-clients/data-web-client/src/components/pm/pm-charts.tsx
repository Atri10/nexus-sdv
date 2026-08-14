'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import TelemetryChart from '@/components/telemetry-chart/TelemetryChart';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

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

/**
 * Four compact live charts (battery health, battery voltage, brake wear,
 * tire pressure) with ~10-minute client-side rolling buffers. Buffers are
 * bounded (a hard cap on top of the time window) so an extended demo never
 * grows memory; the charts are recreated per VIN (buffers reset on switch).
 */
export function PmCharts({ samples }: { samples: PmSample[] }) {
  const theme = useChartTheme();

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
      points: samples
        .map((s) => ({ x: s.t, y: pick(s) ?? null }))
        .filter((p) => p.y !== null),
    });
    return {
      health: [make('health', 'Battery health', COLORS.health, (s) => s.health)],
      voltage: [make('voltage', 'Battery voltage (V)', COLORS.voltage, (s) => s.voltage)],
      brake: [
        make('brake', 'Brake wear %', COLORS.brake, (s) =>
          s.brakeWear === null || s.brakeWear === undefined ? null : s.brakeWear * 100
        ),
      ],
      tires: [make('tires', 'Tire pressure (bar)', COLORS.tires, (s) => s.tirePressure)],
    };
  }, [samples]);

  const chart = (
    title: string,
    key: 'health' | 'voltage' | 'brake' | 'tires',
    yRange?: { min?: number; max?: number }
  ) => (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-base font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-1">
        <div className="h-36">
          <TelemetryChart
            vehicleId="pm"
            series={series[key]}
            type="line"
            axisMode="single"
            hidden={new Set()}
            theme={theme}
            resetZoomToken={0}
            zoomEnabled={false}
            animated={false}
            height="100%"
            yRange={yRange}
          />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {chart('Battery health', 'health', { min: 0, max: 100 })}
      {chart('Battery voltage', 'voltage', { min: 11.8, max: 12.8 })}
      {chart('Brake wear', 'brake', { min: 0, max: 100 })}
      {chart('Tire pressure', 'tires', { min: 1.6, max: 2.5 })}
    </div>
  );
}

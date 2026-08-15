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

/** Severity band thresholds for tinting the current-value readout. */
type Band = { label: string; color: string };

function bandFor(key: 'health' | 'voltage' | 'brake' | 'tires', v: number): Band {
  switch (key) {
    case 'health':
      return v >= 70
        ? { label: 'HEALTHY', color: '#22C55E' }
        : v >= 40
          ? { label: 'ADVISORY', color: '#EAB308' }
          : { label: 'CRITICAL', color: '#EF4444' };
    case 'voltage':
      // Death-collapse aware: below 11.8 V the battery is dying (the chart
      // range now includes the full collapse to ~10.5 V).
      return v >= 12.4
        ? { label: 'HEALTHY', color: '#22C55E' }
        : v >= 11.8
          ? { label: 'ADVISORY', color: '#EAB308' }
          : { label: 'DYING', color: '#EF4444' };
    case 'brake':
      return v <= 60
        ? { label: 'HEALTHY', color: '#22C55E' }
        : v <= 85
          ? { label: 'ADVISORY', color: '#EAB308' }
          : { label: 'CRITICAL', color: '#EF4444' };
    case 'tires':
      // Flat-tire aware: below 1.8 bar the tire is structurally failing.
      return v >= 2.0
        ? { label: 'HEALTHY', color: '#22C55E' }
        : v >= 1.6
          ? { label: 'ADVISORY', color: '#EAB308' }
          : { label: 'FLAT', color: '#EF4444' };
  }
}

/**
 * Four live PM charts (battery health, voltage, brake wear, tire pressure)
 * with ~10-minute client-side rolling buffers. Each card shows the CURRENT
 * value with a severity band, a trend arrow vs the previous sample, and the
 * sparkline. Y-ranges are death-state aware: the voltage range runs to
 * ~10.5 V and tires to ~1.0 bar so the death-cascade climax stays visible
 * instead of clipping off-plot (BUG-P3-8).
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

  const card = (
    title: string,
    key: 'health' | 'voltage' | 'brake' | 'tires',
    unit: string,
    yRange: { min?: number; max?: number }
  ) => {
    const pts = series[key][0].points;
    const last = pts.length ? pts[pts.length - 1].y : null;
    const prev = pts.length > 1 ? pts[pts.length - 2].y : null;
    const trend =
      last === null || prev === null || last === prev
        ? null
        : (last as number) > (prev as number)
          ? '▲'
          : '▼';
    const band = last !== null ? bandFor(key, last as number) : null;

    return (
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 pb-1">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          <div className="flex items-baseline gap-2 font-mono text-sm">
            {band && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{ backgroundColor: `${band.color}22`, color: band.color }}
              >
                {band.label}
              </span>
            )}
            <span className="tabular-nums" style={{ color: band?.color ?? 'inherit' }}>
              {last !== null ? `${Number(last).toFixed(unit === '%' ? 0 : 2)} ${unit}` : '—'}
            </span>
            {trend && (
              <span className={`text-xs ${trend === '▲' ? 'text-emerald-500' : 'text-red-500'}`}>
                {trend}
              </span>
            )}
          </div>
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
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {card('Battery health', 'health', '%', { min: 0, max: 100 })}
      {/* Death-state range: full collapse to ~10.5 V stays on-plot. */}
      {card('Battery voltage', 'voltage', 'V', { min: 10.4, max: 12.8 })}
      {card('Brake wear', 'brake', '%', { min: 0, max: 100 })}
      {/* Flat-tire range: structural collapse to ~1.0 bar stays on-plot. */}
      {card('Tire pressure', 'tires', 'bar', { min: 0.9, max: 2.5 })}
    </div>
  );
}

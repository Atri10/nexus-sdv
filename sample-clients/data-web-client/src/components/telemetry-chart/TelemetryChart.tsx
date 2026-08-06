'use client';

import { useEffect, useRef } from 'react';
import { Chart as ChartJS, ChartData, ChartOptions, ScriptableContext, type Scale } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { registerChart } from '@/lib/register-chart';
import { type ChartThemeColors } from '@/hooks/use-chart-theme';
import { formatValue, groupAxes, type ChartSeries } from '@/lib/telemetry-chart-utils';

registerChart();

interface TelemetryChartProps {
  vehicleId: string;
  series: ChartSeries[];
  type: 'line' | 'area' | 'bar';
  axisMode: 'single' | 'dual';
  hidden: Set<string>;
  theme: ChartThemeColors;
  resetZoomToken: number;
  /** Series key → unit, resolved from component metadata by the caller. */
  units?: Record<string, string>;
}

/**
 * Unit-aware time tick labels: within a single day HH:mm, across days
 * MMM d HH:mm. Formatters are module-cached (Intl constructors are costly).
 */
const withinDayFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const crossDayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function timeTickLabel(this: Scale, tickValue: string | number): string {
  const ts = Number(tickValue);
  if (!isFinite(ts)) return '';
  const crossesDay = new Date(this.min ?? ts).toDateString() !== new Date(this.max ?? ts).toDateString();
  return (crossesDay ? crossDayFormat : withinDayFormat).format(new Date(ts));
}

/** Vertical fade for area fills: series color at ~30% opacity fading to 0. */
function areaFill(ctx: ScriptableContext<'line'>, color: string): string | CanvasGradient {
  const { chart } = ctx;
  if (!chart.chartArea) return color + '33'; // pre-layout pass: solid translucent
  const { ctx: canvas, chartArea } = chart;
  const gradient = canvas.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, color + '4D');
  gradient.addColorStop(1, color + '00');
  return gradient;
}

export default function TelemetryChart({
  vehicleId,
  series,
  type,
  axisMode,
  hidden,
  theme,
  resetZoomToken,
  units = {},
}: TelemetryChartProps) {
  const chartRef = useRef<ChartJS<'line'>>(null);
  const { right } =
    axisMode === 'dual'
      ? groupAxes(series)
      : { right: [] as string[] };
  const rightLabel = right.length > 0 ? (series.find((s) => s.key === right[0])?.label ?? 'Value') : 'Value';

  useEffect(() => {
    if (resetZoomToken > 0) chartRef.current?.resetZoom();
  }, [resetZoomToken]);

  // Left axis title: the shared unit when every visible left series has the
  // same one, otherwise 'Value' (mixed-unit charts).
  const visible = series.filter((s) => !hidden.has(s.key));
  const leftUnits = visible
    .filter((s) => !right.includes(s.key))
    .map((s) => units[s.key])
    .filter((u): u is string => Boolean(u));
  const leftTitle = leftUnits.length > 0 && new Set(leftUnits).size === 1 ? leftUnits[0] : 'Value';
  const rightUnit = right.length > 0 ? units[right[0]] : undefined;
  const rightTitle = rightUnit ? `${rightLabel} (${rightUnit})` : rightLabel;

  const datasets = series
    .filter((s) => !hidden.has(s.key))
    .map((s) => {
      const isRight = right.includes(s.key);
      const isCompare = s.vin !== vehicleId;
      const base: Record<string, unknown> = {
        label: `${isCompare ? s.vin + ' · ' : ''}${s.label}`,
        data: s.points,
        borderColor: s.color,
        backgroundColor:
          type === 'area'
            ? (ctx: ScriptableContext<'line'>) => areaFill(ctx, s.color)
            : s.color,
        yAxisID: isRight ? 'y1' : 'y',
        spanGaps: true,
        borderWidth: 2,
        // Compare VINs render dashed so series stay distinguishable beyond color.
        borderDash: isCompare ? [6, 4] : undefined,
        pointRadius: type === 'bar' ? 2 : 0,
        pointHoverRadius: 5,
        tension: 0.25,
        fill: type === 'area',
        // Tooltip suffix; undefined for series without a unit.
        unit: units[s.key],
      };
      if (type === 'bar') {
        base.type = 'bar';
        base.borderWidth = 0;
        base.borderRadius = 2;
      } else {
        base.type = 'line';
      }
      return base as unknown as ChartData<'line'>['datasets'][number];
    });

  const data: ChartData<'line'> = {
    datasets: datasets as ChartData<'line'>['datasets'],
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    // Data is already {x, y} with numeric values; decimation requires
    // parsing to be off (chart.js requirement).
    parsing: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        type: 'time',
        time: {
          tooltipFormat: 'HH:mm:ss',
          // Tick label defaults (overridden per-tick by the Intl callback);
          // kept so non-tick consumers (e.g. axis bounds) render consistently.
          displayFormats: {
            millisecond: 'HH:mm:ss.SSS',
            second: 'HH:mm:ss',
            minute: 'HH:mm',
            hour: 'HH:mm',
          },
        },
        grid: { color: theme.grid },
        ticks: {
          color: theme.ticks,
          maxTicksLimit: 12,
          font: { family: theme.fontFamily },
          callback: timeTickLabel,
        },
        title: { display: true, text: 'Time', color: theme.ticks, font: { family: theme.fontFamily } },
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        grid: { color: theme.grid },
        ticks: { color: theme.ticks, font: { family: theme.fontFamily }, callback: (v) => formatValue(Number(v)) },
        title: { display: true, text: leftTitle, color: theme.ticks, font: { family: theme.fontFamily } },
      },
      y1: {
        type: 'linear',
        display: right.length > 0,
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: theme.ticks, font: { family: theme.fontFamily }, callback: (v) => formatValue(Number(v)) },
        title: { display: true, text: rightTitle, color: theme.ticks, font: { family: theme.fontFamily } },
      },
    },
    plugins: {
      // Series toggling lives in ChartControls' color chips — the default
      // legend would duplicate it.
      legend: { display: false },
      title: {
        display: true,
        text: `Telemetry: ${vehicleId}`,
        color: theme.title,
        font: { family: theme.fontFamily },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        titleColor: '#e2e8f0',
        bodyColor: '#e2e8f0',
        titleFont: { family: theme.fontFamily },
        bodyFont: { family: theme.fontFamily },
        borderColor: 'rgba(148, 163, 184, 0.25)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
        callbacks: {
          label: (item) => {
            const { label, unit } = item.dataset as { label?: string; unit?: string };
            return `${label ?? ''}: ${formatValue(item.parsed.y ?? NaN)}${unit ? ` ${unit}` : ''}`;
          },
        },
      },
      hudCrosshair: { color: theme.crosshair },
      // Dense line/area series decimate with chart.js's built-in lttb so
      // 1000+ point pans stay smooth. Bar datasets are skipped by the
      // plugin itself (supportsDecimation); decimation applies at render —
      // acceptable alongside zoom (zooming below the threshold restores the
      // raw points naturally).
      decimation: { enabled: true, algorithm: 'lttb', threshold: 400, samples: 100 },
      zoom: {
        zoom: { wheel: { enabled: true }, drag: { enabled: true }, mode: 'x' },
        pan: { enabled: true, mode: 'xy' },
        limits: { y: { min: 'original', max: 'original' } },
      },
    },
  };

  return (
    <div className="relative h-[400px] w-full">
      <Line ref={chartRef} data={data} options={options} />
    </div>
  );
}

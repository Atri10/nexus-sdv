'use client';

import { useEffect, useRef } from 'react';
import { Chart as ChartJS, ChartData, ChartOptions, ScriptableContext } from 'chart.js';
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
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'HH:mm:ss' },
        grid: { color: theme.grid },
        ticks: { color: theme.ticks, maxTicksLimit: 12 },
        title: { display: true, text: 'Time', color: theme.ticks },
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        grid: { color: theme.grid },
        ticks: { color: theme.ticks, callback: (v) => formatValue(Number(v)) },
        title: { display: true, text: 'Value', color: theme.ticks },
      },
      y1: {
        type: 'linear',
        display: right.length > 0,
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: theme.ticks, callback: (v) => formatValue(Number(v)) },
        title: { display: true, text: rightLabel, color: theme.ticks },
      },
    },
    plugins: {
      // Series toggling lives in ChartControls' color chips — the default
      // legend would duplicate it.
      legend: { display: false },
      title: { display: true, text: `Telemetry: ${vehicleId}`, color: theme.title },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        titleColor: '#e2e8f0',
        bodyColor: '#e2e8f0',
        borderColor: 'rgba(148, 163, 184, 0.25)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
        callbacks: {
          label: (item) =>
            `${String((item.dataset as { label?: string }).label ?? '')}: ${formatValue(item.parsed.y ?? NaN)}`,
        },
      },
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

'use client';

import { useEffect, useRef } from 'react';
import { Chart as ChartJS, ChartData, ChartOptions } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { registerChart } from '@/lib/register-chart';
import { type ChartThemeColors } from '@/hooks/use-chart-theme';
import { groupAxes, type ChartSeries } from '@/lib/telemetry-chart-utils';

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

  useEffect(() => {
    if (resetZoomToken > 0) chartRef.current?.resetZoom();
  }, [resetZoomToken]);

  const datasets = series
    .filter((s) => !hidden.has(s.key))
    .map((s) => {
      const isRight = right.includes(s.key);
      const base: Record<string, unknown> = {
        label: `${s.vin !== vehicleId ? s.vin + ' · ' : ''}${s.label}`,
        data: s.points,
        borderColor: s.color,
        backgroundColor: type === 'area' ? s.color + '33' : s.color,
        yAxisID: isRight ? 'y1' : 'y',
        spanGaps: true,
        pointRadius: 2,
        pointHoverRadius: 5,
        tension: 0.2,
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
        ticks: { color: theme.ticks },
        title: { display: true, text: 'Time', color: theme.ticks },
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        grid: { color: theme.grid },
        ticks: { color: theme.ticks },
        title: { display: true, text: 'Value', color: theme.ticks },
      },
      y1: {
        type: 'linear',
        display: right.length > 0,
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: theme.ticks },
        title: { display: true, text: '0–100', color: theme.ticks },
      },
    },
    plugins: {
      legend: { display: true, position: 'top', labels: { color: theme.legend } },
      title: { display: true, text: `Telemetry: ${vehicleId}`, color: theme.title },
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

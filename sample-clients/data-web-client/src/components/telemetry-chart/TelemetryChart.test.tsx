import { render } from '@testing-library/react';
import TelemetryChart from './TelemetryChart';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

const theme: ChartThemeColors = {
  grid: '#e5e7eb',
  ticks: '#6b7280',
  legend: '#374151',
  title: '#111827',
};

function makeSeries(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    vin: 'VIN-1',
    column: 'speed',
    key: 'speed',
    label: 'Speed',
    color: '#3B82F6',
    points: [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ],
    ...overrides,
  };
}

describe('TelemetryChart', () => {
  it('renders a canvas for the line type', () => {
    const { container } = render(
      <TelemetryChart
        vehicleId="VIN-1"
        series={[makeSeries()]}
        type="line"
        axisMode="single"
        hidden={new Set<string>()}
        theme={theme}
        resetZoomToken={0}
      />,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('renders a canvas for the bar type', () => {
    const { container } = render(
      <TelemetryChart
        vehicleId="VIN-1"
        series={[makeSeries()]}
        type="bar"
        axisMode="single"
        hidden={new Set<string>()}
        theme={theme}
        resetZoomToken={0}
      />,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('renders a canvas for the area type', () => {
    const { container } = render(
      <TelemetryChart
        vehicleId="VIN-1"
        series={[makeSeries()]}
        type="area"
        axisMode="single"
        hidden={new Set<string>()}
        theme={theme}
        resetZoomToken={0}
      />,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('renders without crashing when a series is hidden', () => {
    const { container } = render(
      <TelemetryChart
        vehicleId="VIN-1"
        series={[makeSeries()]}
        type="line"
        axisMode="single"
        hidden={new Set<string>(['speed'])}
        theme={theme}
        resetZoomToken={0}
      />,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('renders without crashing in dual-axis mode', () => {
    const { container } = render(
      <TelemetryChart
        vehicleId="VIN-1"
        series={[
          makeSeries(),
          makeSeries({ key: 'temp', label: 'Temp', column: 'temp', points: [{ x: 1, y: 50 }] }),
        ]}
        type="line"
        axisMode="dual"
        hidden={new Set<string>()}
        theme={theme}
        resetZoomToken={0}
      />,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
  });
});

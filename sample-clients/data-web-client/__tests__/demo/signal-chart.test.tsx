import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignalChart } from '@/components/demo/signal-chart';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

const THEME = {
  grid: '#e5e7eb',
  ticks: '#6b7280',
  legend: '#6b7280',
  series: ['#3B82F6'],
};

const SERIES = {
  vin: 'VIN1001',
  column: 'dynamic:battery.voltage',
  key: 'VIN1001|dynamic:battery.voltage',
  label: 'battery.voltage',
  color: '#3B82F6',
  points: [
    { x: 1, y: 12.5 },
    { x: 2, y: 12.6 },
  ],
} as ChartSeries;

describe('SignalChart', () => {
  it('shows label, unit and latest value', () => {
    render(<SignalChart series={SERIES} unit="V" paused={false} theme={THEME} onExpand={() => {}} />);
    expect(screen.getByText('battery.voltage')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('12.6'))).toBeInTheDocument();
  });

  it('marks paused charts and keeps history', () => {
    render(<SignalChart series={SERIES} unit="V" paused theme={THEME} onExpand={() => {}} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('fires onExpand', () => {
    const onExpand = jest.fn();
    render(<SignalChart series={SERIES} unit="V" paused={false} theme={THEME} onExpand={onExpand} />);
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(onExpand).toHaveBeenCalled();
  });
});

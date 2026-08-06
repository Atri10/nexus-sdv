import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { VehicleMap } from '@/components/demo/vehicle-map';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

const series = (column: string, points: ChartSeries['points']): ChartSeries => ({
  vin: 'VIN1001',
  column,
  key: `VIN1001|${column}`,
  label: column.split(':')[1],
  color: '#3B82F6',
  points,
});

describe('VehicleMap', () => {
  it('renders the header with coordinates once a fix exists', () => {
    render(
      <VehicleMap
        paused={false}
        series={[
          series('dynamic:GPS_LATITUDE', [{ x: 1, y: 10.12345 }]),
          series('dynamic:GPS_LONGITUDE', [{ x: 1, y: 20.98765 }]),
        ]}
      />
    );
    expect(screen.getByText('LIVE GPS TRACK')).toBeInTheDocument();
    expect(screen.getByText(/10\.12345°/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /live gps track map/i })).toBeInTheDocument();
  });

  it('shows a waiting hint without fixes', () => {
    render(<VehicleMap paused={false} series={[]} />);
    expect(screen.getByText(/Waiting for GPS signal/)).toBeInTheDocument();
    expect(screen.getByText(/—/)).toBeInTheDocument();
  });

  it('shows the paused overlay when the component is paused', () => {
    render(
      <VehicleMap
        paused
        series={[
          series('dynamic:GPS_LATITUDE', [{ x: 1, y: 10.12345 }]),
          series('dynamic:GPS_LONGITUDE', [{ x: 1, y: 20.98765 }]),
        ]}
      />
    );
    expect(screen.getByText(/Paused — track retained/)).toBeInTheDocument();
  });
});

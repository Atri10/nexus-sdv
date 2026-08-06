import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { VehicleSchematic } from '@/components/demo/vehicle-schematic';
import type { ComponentStatus } from '@/lib/demo-control';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery',
    label: 'Battery',
    enabled: true,
    sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }],
  },
  { id: 'cabin', label: 'Cabin', enabled: false, sensors: [] },
];

const SERIES = [
  {
    vin: 'VIN1001',
    column: 'dynamic:battery.voltage',
    key: 'VIN1001|dynamic:battery.voltage',
    label: 'battery.voltage',
    color: '#3B82F6',
    points: [
      { x: 1, y: 12.5 },
      { x: 2, y: 12.6 },
    ],
  },
];

describe('VehicleSchematic', () => {
  it('renders discovered component nodes and live sensor chips', () => {
    render(
      <VehicleSchematic
        componentId="battery"
        onSelect={() => {}}
        series={SERIES}
        components={COMPONENTS}
      />
    );
    expect(screen.getByRole('button', { name: /Battery component/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cabin component/ })).toBeInTheDocument();
    expect(screen.getByText('Voltage')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('12.6'))).toBeInTheDocument();
  });

  it('renders empty chips when nothing is discovered', () => {
    render(
      <VehicleSchematic componentId="battery" onSelect={jest.fn()} series={SERIES} components={null} />
    );
    expect(screen.queryByText('Voltage')).not.toBeInTheDocument();
  });
});

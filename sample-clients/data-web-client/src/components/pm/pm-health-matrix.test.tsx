import { describe, expect, it, vi } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { PmHealthMatrix, PM_COMPONENT_SENSORS, pmSeriesForComponent } from './pm-health-matrix';
import type { PmMessage } from '@/lib/pm-types';

const base = (overrides: Partial<PmMessage>): PmMessage => ({
  vin: 'VIN1001',
  component: 'battery',
  health_score: 62,
  severity: 'advisory',
  evidence: { ewma_voltage: '12.38' },
  explanation: 'Resting voltage 12.38 V.',
  timestamp: '2026-08-09T00:00:00Z',
  ...overrides,
});

describe('pmSeriesForComponent', () => {
  it('filters series by the component sensor qualifiers (family prefix stripped)', () => {
    const series = [
      { column: 'dynamic:battery.voltage' },
      { column: 'dynamic:TIRE_PRESSURE' },
      { column: 'dynamic:BRAKE_PEDAL_PCT' },
      { column: 'dynamic:VELOCITY' },
      { column: 'dynamic:ENGINE_RPM' },
    ];
    expect(pmSeriesForComponent(series, 'battery').map((s) => s.column)).toEqual([
      'dynamic:battery.voltage',
    ]);
    expect(pmSeriesForComponent(series, 'tires').map((s) => s.column)).toEqual([
      'dynamic:TIRE_PRESSURE',
    ]);
    expect(pmSeriesForComponent(series, 'brake').map((s) => s.column).sort()).toEqual([
      'dynamic:BRAKE_PEDAL_PCT',
      'dynamic:VELOCITY',
    ]);
  });

  it('declares the /pm vocabulary components with their sensors', () => {
    expect(Object.keys(PM_COMPONENT_SENSORS).sort()).toEqual(['battery', 'brake', 'tires']);
    expect(PM_COMPONENT_SENSORS.battery).toContain('battery.voltage');
    expect(PM_COMPONENT_SENSORS.tires).toEqual(['TIRE_PRESSURE', 'TIRE_TEMP']);
  });
});

describe('PmHealthMatrix', () => {
  const onSelect = vi.fn();

  it('renders one row per VIN with battery/brake/tires columns', () => {
    render(
      <PmHealthMatrix vins={['VIN1001', 'VIN1002']} messages={[]} selected={null} onSelect={onSelect} />,
    );
    expect(screen.getByText('VIN1001')).toBeInTheDocument();
    expect(screen.getByText('VIN1002')).toBeInTheDocument();
    for (const col of ['BATTERY', 'BRAKE', 'TIRES']) {
      expect(screen.getByText(col)).toBeInTheDocument();
    }
    // No messages → every cell shows the dash.
    expect(screen.getAllByText('—')).toHaveLength(6);
  });

  it('shows the latest health score per vin+component with the severity color', () => {
    const messages: PmMessage[] = [
      base({ vin: 'VIN1001', component: 'battery', health_score: 62, severity: 'advisory' }),
      base({ vin: 'VIN1001', component: 'tires', health_score: 25, severity: 'critical' }),
      // Older message for the same pair must NOT override the newest.
      base({ vin: 'VIN1001', component: 'battery', health_score: 10, severity: 'critical', timestamp: '2026-08-01T00:00:00Z' }),
    ];
    render(<PmHealthMatrix vins={['VIN1001']} messages={messages} selected={null} onSelect={onSelect} />);
    const batteryCell = screen.getByRole('button', { name: 'Drill down battery health for VIN1001' });
    expect(batteryCell.textContent).toBe('62');
    // Newest-first: the 62/advisory message wins over the 10/critical one.
    expect(batteryCell.style.color).toBe('#F59E0B'); // advisory amber
    const tiresCell = screen.getByRole('button', { name: 'Drill down tires health for VIN1001' });
    expect(tiresCell.textContent).toBe('25');
    expect(tiresCell.style.color).toBe('#DC2626'); // critical red
  });

  it('calls onSelect with vin+component on cell click', () => {
    const messages: PmMessage[] = [base({ vin: 'VIN1001', component: 'brake', health_score: 88, severity: 'healthy' })];
    render(<PmHealthMatrix vins={['VIN1001']} messages={messages} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drill down brake health for VIN1001' }));
    expect(onSelect).toHaveBeenCalledWith('VIN1001', 'brake');
  });

  it('shows an empty state when no VINs are supplied', () => {
    render(<PmHealthMatrix vins={[]} messages={[]} selected={null} onSelect={onSelect} />);
    expect(screen.getByText(/No vehicles found/)).toBeInTheDocument();
  });
});

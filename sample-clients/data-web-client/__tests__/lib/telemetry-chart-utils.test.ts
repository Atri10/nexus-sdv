import { describe, it, expect } from 'bun:test';
import { groupAxes, formatValue } from '@/lib/telemetry-chart-utils';

describe('groupAxes', () => {
  it('puts ~0-100 series on right axis when another series is >5x larger', () => {
    const series = [
      { vin: 'A', column: 'FUEL_LEVEL', key: 'A|FUEL_LEVEL', label: 'FUEL_LEVEL', color: '#000', points: [{ x: 1, y: 50 }] },
      { vin: 'A', column: 'ENGINE_RPM', key: 'A|ENGINE_RPM', label: 'ENGINE_RPM', color: '#111', points: [{ x: 1, y: 900 }] },
    ];
    const { left, right } = groupAxes(series);
    expect(right).toContain('A|FUEL_LEVEL');
    expect(left).toContain('A|ENGINE_RPM');
  });

  it('keeps everything on left when magnitudes are similar', () => {
    const series = [
      { vin: 'A', column: 'X', key: 'A|X', label: 'X', color: '#000', points: [{ x: 1, y: 50 }] },
      { vin: 'A', column: 'Y', key: 'A|Y', label: 'Y', color: '#111', points: [{ x: 1, y: 60 }] },
    ];
    const { left, right } = groupAxes(series);
    expect(right).toHaveLength(0);
    expect(left).toHaveLength(2);
  });
});

describe('formatValue', () => {
  it('rounds to 2 decimals', () => {
    expect(formatValue(49.456)).toBe('49.46');
  });
});
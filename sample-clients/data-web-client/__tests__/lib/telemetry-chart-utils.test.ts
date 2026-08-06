import { describe, it, expect } from 'bun:test';
import { groupAxes, formatValue, columnQualifier, unitsForSeries } from '@/lib/telemetry-chart-utils';

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

describe('columnQualifier', () => {
  it('strips the family prefix', () => {
    expect(columnQualifier('dynamic:battery.voltage')).toBe('battery.voltage');
    expect(columnQualifier('static:make')).toBe('make');
    expect(columnQualifier('ENGINE_POWER')).toBe('ENGINE_POWER');
  });
});

describe('unitsForSeries', () => {
  function s(column: string, key: string) {
    return { vin: 'A', column, key, label: key, color: '#000', points: [] };
  }

  it('maps series keys to units from the component metadata', () => {
    const units = unitsForSeries([
      s('dynamic:battery.voltage', 'A|battery.voltage'),
      s('dynamic:VELOCITY', 'A|VELOCITY'),
      s('dynamic:ENGINE_RPM', 'A|ENGINE_RPM'),
    ]);
    expect(units['A|battery.voltage']).toBe('V');
    expect(units['A|VELOCITY']).toBe('km/h');
    expect(units['A|ENGINE_RPM']).toBe('rpm');
  });

  it('omits series without a declared unit', () => {
    const units = unitsForSeries([
      s('dynamic:GPS_LATITUDE', 'A|GPS_LATITUDE'),
      s('static:make', 'A|make'),
    ]);
    expect(units).toEqual({});
  });

  it('is empty for an empty series list', () => {
    expect(unitsForSeries([])).toEqual({});
  });
});
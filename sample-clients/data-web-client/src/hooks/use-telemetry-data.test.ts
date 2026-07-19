import { describe, it, expect } from 'bun:test';
import { shapeRows } from '@/hooks/use-telemetry-data';

describe('shapeRows', () => {
  it('builds one series per column with numeric x/y', () => {
    const rows = [
      { timestamp: '2026-07-19T10:00:00Z', values: { 'dynamic:ENGINE_RPM': '900', 'dynamic:FUEL_LEVEL': '49' } },
      { timestamp: '2026-07-19T10:00:01Z', values: { 'dynamic:ENGINE_RPM': '910', 'dynamic:FUEL_LEVEL': '48' } },
    ];
    const series = shapeRows('VIN1', rows);
    expect(series).toHaveLength(2);
    const rpm = series.find((s) => s.column === 'dynamic:ENGINE_RPM')!;
    expect(rpm.points[0]).toEqual({ x: Date.parse('2026-07-19T10:00:00Z'), y: 900 });
    expect(rpm.label).toBe('ENGINE_RPM');
  });

  it('skips non-numeric values as null', () => {
    const rows = [{ timestamp: '2026-07-19T10:00:00Z', values: { 'dynamic:X': '---' } }];
    const series = shapeRows('V1', rows);
    expect(series[0].points[0].y).toBeNull();
  });
});
import { describe, expect, it } from 'bun:test';
import { buildTableRows, latestValues } from '@/lib/telemetry-table';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

function series(vin: string, column: string, points: [number, number | null][]): ChartSeries {
  return {
    vin,
    column,
    key: `${vin}|${column}`,
    label: column.replace('dynamic:', ''),
    color: '#3B82F6',
    points: points.map(([x, y]) => ({ x, y })),
  };
}

describe('buildTableRows', () => {
  it('unions timestamps across series in ascending order', () => {
    const speed = series('VIN123', 'dynamic:speed', [[2000, 10], [4000, 20]]);
    const rpm = series('VIN123', 'dynamic:rpm', [[1000, 5], [3000, 15]]);
    const rows = buildTableRows([speed, rpm]);

    expect(rows.map((r) => r.tsKey)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('merges values from all series at shared timestamps', () => {
    const speed = series('VIN123', 'dynamic:speed', [[2000, 10]]);
    const rpm = series('VIN123', 'dynamic:rpm', [[2000, 5000]]);
    const rows = buildTableRows([speed, rpm]);

    expect(rows).toHaveLength(1);
    expect(rows[0].values['VIN123|dynamic:speed']).toBe(10);
    expect(rows[0].values['VIN123|dynamic:rpm']).toBe(5000);
  });

  it('fills null for series missing a timestamp (no index-based misalignment)', () => {
    const speed = series('VIN123', 'dynamic:speed', [[2000, 10], [4000, 20]]);
    const rpm = series('VIN123', 'dynamic:rpm', [[1000, 5]]);
    const rows = buildTableRows([speed, rpm]);

    const row4000 = rows.find((r) => r.tsKey === 4000);
    expect(row4000).toBeDefined();
    expect(row4000!.values['VIN123|dynamic:speed']).toBe(20);
    expect(row4000!.values['VIN123|dynamic:rpm']).toBeNull();
  });

  it('keeps compare-VIN series separate when columns collide', () => {
    const a = series('VIN123', 'dynamic:speed', [[2000, 10]]);
    const b = series('VIN456', 'dynamic:speed', [[2000, 80]]);
    const rows = buildTableRows([a, b]);

    expect(rows[0].values['VIN123|dynamic:speed']).toBe(10);
    expect(rows[0].values['VIN456|dynamic:speed']).toBe(80);
  });

  it('handles duplicate x values by keeping the last point', () => {
    const speed = series('VIN123', 'dynamic:speed', [[2000, 10], [2000, 12]]);
    const rows = buildTableRows([speed]);

    expect(rows).toHaveLength(1);
    expect(rows[0].values['VIN123|dynamic:speed']).toBe(12);
  });

  it('returns an empty array for no series', () => {
    expect(buildTableRows([])).toEqual([]);
  });
});

describe('latestValues', () => {
  it('returns the last non-null point per series', () => {
    const speed = series('VIN123', 'dynamic:speed', [[1000, 10], [2000, null], [3000, 42]]);
    const stats = latestValues([speed]);

    expect(stats).toHaveLength(1);
    expect(stats[0].value).toBe(42);
    expect(stats[0].timestamp).toBe(3000);
  });

  it('reports null value when a series has no numeric points', () => {
    const battery = series('VIN123', 'dynamic:battery', [[1000, null], [2000, null]]);
    const stats = latestValues([battery]);

    expect(stats[0].value).toBeNull();
    expect(stats[0].timestamp).toBeNull();
    expect(stats[0].previous).toBeNull();
    expect(stats[0].history).toEqual([]);
  });

  it('preserves key, label and color for rendering', () => {
    const s = series('VIN123', 'dynamic:speed', [[1000, 10]]);
    const stats = latestValues([s]);

    expect(stats[0].key).toBe('VIN123|dynamic:speed');
    expect(stats[0].label).toBe('speed');
    expect(stats[0].color).toBe('#3B82F6');
  });

  it('tracks previous as the second-to-last numeric value across nulls', () => {
    const speed = series('VIN123', 'dynamic:speed', [[1000, 10], [2000, null], [3000, 42]]);
    const stats = latestValues([speed]);

    expect(stats[0].value).toBe(42);
    expect(stats[0].previous).toBe(10);
  });

  it('chains previous through more than two numeric points', () => {
    const speed = series('VIN123', 'dynamic:speed', [[1000, 10], [2000, 20], [3000, 30]]);
    const stats = latestValues([speed]);

    expect(stats[0].value).toBe(30);
    expect(stats[0].previous).toBe(20);
  });

  it('leaves previous null when only one numeric point exists', () => {
    const speed = series('VIN123', 'dynamic:speed', [[1000, 10], [2000, null]]);
    const stats = latestValues([speed]);

    expect(stats[0].value).toBe(10);
    expect(stats[0].previous).toBeNull();
  });

  it('collects history from numeric points only, in order', () => {
    const speed = series('VIN123', 'dynamic:speed', [[1000, 10], [2000, null], [3000, 42], [4000, 55]]);
    const stats = latestValues([speed]);

    expect(stats[0].history).toEqual([
      { x: 1000, y: 10 },
      { x: 3000, y: 42 },
      { x: 4000, y: 55 },
    ]);
  });

  it('caps history at the last 20 points', () => {
    const points = Array.from({ length: 25 }, (_, i) => [i * 1000, i + 1] as [number, number]);
    const stats = latestValues([series('VIN123', 'dynamic:speed', points)]);

    expect(stats[0].history).toHaveLength(20);
    expect(stats[0].history[0]).toEqual({ x: 5000, y: 6 });
    expect(stats[0].history[19]).toEqual({ x: 24000, y: 25 });
    expect(stats[0].value).toBe(25);
    expect(stats[0].previous).toBe(24);
  });

  it('returns empty history for an empty series', () => {
    const stats = latestValues([series('VIN123', 'dynamic:speed', [])]);

    expect(stats[0].value).toBeNull();
    expect(stats[0].previous).toBeNull();
    expect(stats[0].history).toEqual([]);
  });
});

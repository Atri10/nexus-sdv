import { describe, expect, it, mock } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { shapeRows, useTelemetryData } from '@/hooks/use-telemetry-data';

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

  it('converts vehicle velocity from stored m/s to the dashboard km/h unit', () => {
    const rows = [{ timestamp: '2026-07-19T10:00:00Z', values: { 'dynamic:VELOCITY': '23.52' } }];
    const series = shapeRows('VIN1', rows);
    expect(series[0].points[0].y).toBeCloseTo(84.672, 8);
  });

  it('carries non-numeric strings as raw values (static readings)', () => {
    const rows = [
      { timestamp: '2026-07-19T10:00:00Z', values: { 'static:make': 'Nexus SDV', 'static:index': '42' } },
    ];
    const series = shapeRows('VIN1', rows);
    const make = series.find((s) => s.column === 'static:make')!;
    expect(make.points[0]).toEqual({ x: Date.parse('2026-07-19T10:00:00Z'), y: null, raw: 'Nexus SDV' });
    const index = series.find((s) => s.column === 'static:index')!;
    expect(index.points[0]).toEqual({ x: Date.parse('2026-07-19T10:00:00Z'), y: 42 });
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
}
// @ts-expect-error minimal stub for test env
globalThis.WebSocket = FakeWebSocket;

const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        rows: [
          { timestamp: '2026-08-05T00:00:00.000000000Z', values: { 'dynamic:speed': '42' } },
        ],
        columns: ['dynamic:speed'],
      }),
  })
);
// @ts-expect-error minimal stub for test env
globalThis.fetch = mockFetch;

describe('useTelemetryData', () => {
  it('stores fetched historical data in series (regression: load() discarded it)', async () => {
    const { result } = renderHook(() => useTelemetryData({ vin: 'VIN123', range: '1h' }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.series).toHaveLength(1);
    expect(result.current.series[0].column).toBe('dynamic:speed');
    expect(result.current.series[0].points[0]?.y).toBe(42);
    expect(mockFetch).toHaveBeenCalled();
  });
});

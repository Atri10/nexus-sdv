import { describe, expect, it } from 'bun:test';
import { liveValueForColumn, mergeLiveSnapshot } from './telemetry-snapshot';
import type { DemoControlReply } from './demo-control';
import type { ChartSeries } from './telemetry-chart-utils';

const snapshot: DemoControlReply = {
  vin: 'VIN1001',
  observed_at: '2026-08-17T16:18:08.642954007Z',
  running: true,
  published: 10,
  messageType: 'both',
  live: {
    battery_voltage: 12.1,
    battery_current: 45.86,
    battery_soc: 25.9,
    battery_temp: 33.29,
    velocity_m_s: 23.52,
    tire_pressure_bar: 2.3,
    tire_temp_c: 26.61,
    lat: 12.973068,
    lng: 77.594742,
    heading_deg: 39.65,
    steering_angle_deg: 0.99,
    accelerator_pedal_pct: 8,
    brake_pedal_pct: 0,
    engine_power: 12.29,
    engine_rpm: 1650.76,
    fuel_capacity: 50,
    fuel_level: 57.2,
  },
  ground_truth: {
    tires: {
      FL: { pressure_bar: 2.3, temp_c: 26.61 },
      FR: { pressure_bar: 2.3, temp_c: 26.61 },
      RL: { pressure_bar: 2.3, temp_c: 26.61 },
      RR: { pressure_bar: 2.3, temp_c: 26.61 },
      pressure_bar: 2.3,
      temp_c: 26.61,
    },
    brakes: {
      FL: { wear_fraction: 0.0062 },
      FR: { wear_fraction: 0.0055 },
      RL: { wear_fraction: 0.0035 },
      RR: { wear_fraction: 0.0024 },
    },
  },
};

function series(column: string, points: ChartSeries['points']): ChartSeries {
  return { vin: 'VIN1001', column, key: column, label: column, color: '#fff', points };
}

describe('liveValueForColumn', () => {
  it('maps simulator live and ground-truth fields to chart columns', () => {
    expect(liveValueForColumn('dynamic:battery.voltage', snapshot)).toBe(12.1);
    expect(liveValueForColumn('dynamic:VELOCITY', snapshot)).toBeCloseTo(84.672, 8);
    expect(liveValueForColumn('dynamic:gps.latitude', snapshot)).toBe(12.973068);
    expect(liveValueForColumn('dynamic:TIRE_PRESSURE.FL', snapshot)).toBe(2.3);
    expect(liveValueForColumn('dynamic:BRAKE_WEAR.FL', snapshot)).toBe(0.0062);
    expect(liveValueForColumn('dynamic:ENGINE_RPM', snapshot)).toBe(1650.76);
  });
});

describe('mergeLiveSnapshot', () => {
  it('aligns every available live series to the one observed frame', () => {
    const observedAt = Date.parse(snapshot.observed_at!);
    const merged = mergeLiveSnapshot([
      series('dynamic:battery.voltage', [{ x: observedAt - 2000, y: 12.11 }]),
      series('dynamic:battery.soc', [{ x: observedAt - 2000, y: 26.22 }]),
      series('static:make', [{ x: observedAt - 2000, y: null, raw: 'Nexus SDV' }]),
    ], snapshot);

    expect(merged[0].points.at(-1)).toEqual({ x: observedAt, y: 12.1 });
    expect(merged[1].points.at(-1)).toEqual({ x: observedAt, y: 25.9 });
    expect(merged[2].points).toHaveLength(1);
  });

  it('replaces a chart-service point when it has the same frame timestamp', () => {
    const observedAt = Date.parse(snapshot.observed_at!);
    const merged = mergeLiveSnapshot([
      series('dynamic:battery.voltage', [{ x: observedAt, y: 12.11 }]),
    ], snapshot);
    expect(merged[0].points).toEqual([{ x: observedAt, y: 12.1 }]);
  });
});

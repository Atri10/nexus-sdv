import { describe, expect, it } from 'bun:test';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import { DEMO_COMPONENTS, latestValuesFor, seriesForComponent } from '@/lib/demo/vehicle-components';

/**
 * Connector contract (base-services/nats-bigtable-connector): columns are
 * `family:qualifier` with family dynamic|static. TelemetryMessage sensors are
 * battery.voltage/current/soc/temp; MetricsReport flattens ENGINE_POWER,
 * ENGINE_RPM, FUEL_LEVEL, FUEL_CAPACITY, TIRE_PRESSURE, VELOCITY,
 * GPS_LATITUDE, GPS_LONGITUDE plus VehicleDynamics STEERING_ANGLE_DEG,
 * ACCELERATOR_PEDAL_PCT, BRAKE_PEDAL_PCT; static readings are make/index.
 */
const CONNECTOR_QUALIFIERS: Record<string, true> = {
  // TelemetryMessage sensors (dynamic family)
  'battery.voltage': true,
  'battery.current': true,
  'battery.soc': true,
  'battery.temp': true,
  // MetricsReport columns (dynamic family)
  ENGINE_POWER: true,
  ENGINE_RPM: true,
  FUEL_LEVEL: true,
  FUEL_CAPACITY: true,
  TIRE_PRESSURE: true,
  VELOCITY: true,
  GPS_LATITUDE: true,
  GPS_LONGITUDE: true,
  STEERING_ANGLE_DEG: true,
  ACCELERATOR_PEDAL_PCT: true,
  BRAKE_PEDAL_PCT: true,
  // static readings
  make: true,
  index: true,
};

function series(vin: string, column: string, points: [number, number | null, string?][]): ChartSeries {
  return {
    vin,
    column,
    key: `${vin}|${column}`,
    label: column.replace('dynamic:', '').replace('static:', ''),
    color: '#000000',
    points: points.map(([x, y, raw]) => (raw !== undefined ? { x, y, raw } : { x, y })),
  };
}

describe('DEMO_COMPONENTS metadata', () => {
  it('declares the four components with ids battery, powertrain, chassis, cabin', () => {
    expect(DEMO_COMPONENTS.map((c) => c.id)).toEqual(['battery', 'powertrain', 'chassis', 'cabin']);
  });

  it('uses only qualifiers that exist in the connector contract', () => {
    for (const component of DEMO_COMPONENTS) {
      for (const sensor of component.sensors) {
        expect(CONNECTOR_QUALIFIERS[sensor.qualifier], `${component.id}: ${sensor.qualifier}`).toBe(true);
      }
    }
  });

  it('keeps cabin sensors split between dynamic and static qualifiers', () => {
    const cabin = DEMO_COMPONENTS.find((c) => c.id === 'cabin')!;
    expect(cabin.sensors.map((s) => s.qualifier)).toEqual(['battery.temp', 'make', 'index']);
  });
});

describe('seriesForComponent', () => {
  it('matches by column qualifier after the family prefix', () => {
    const all = [
      series('VIN1', 'dynamic:battery.voltage', [[1, 12.4]]),
      series('VIN1', 'dynamic:battery.soc', [[1, 80]]),
      series('VIN1', 'dynamic:VELOCITY', [[1, 50]]),
    ];
    const battery = seriesForComponent(all, 'battery');
    expect(battery.map((s) => s.column).sort()).toEqual(['dynamic:battery.soc', 'dynamic:battery.voltage']);
  });

  it('matches static qualifiers (make/index) for cabin', () => {
    const all = [
      series('VIN1', 'dynamic:battery.temp', [[1, 25]]),
      series('VIN1', 'static:make', []),
      series('VIN1', 'static:index', []),
    ];
    const cabin = seriesForComponent(all, 'cabin');
    expect(cabin.map((s) => s.column).sort()).toEqual(['dynamic:battery.temp', 'static:index', 'static:make']);
  });

  it('ignores qualifiers from other components and works across VINs', () => {
    const all = [
      series('VIN1', 'dynamic:ENGINE_POWER', [[1, 100]]),
      series('VIN2', 'dynamic:battery.voltage', [[1, 12.1]]), // compare VIN, same key scheme
      series('VIN2', 'dynamic:STEERING_ANGLE_DEG', [[1, -3]]),
    ];
    const chassis = seriesForComponent(all, 'chassis');
    expect(chassis.map((s) => s.column)).toEqual(['dynamic:STEERING_ANGLE_DEG']);
    const battery = seriesForComponent(all, 'battery');
    expect(battery.map((s) => s.vin)).toEqual(['VIN2']);
  });

  it('returns [] for an unknown component or unmatched qualifiers', () => {
    expect(seriesForComponent([], 'battery')).toEqual([]);
    expect(seriesForComponent([series('VIN1', 'dynamic:battery.voltage', [[1, 1]])], 'nope')).toEqual([]);
  });
});

describe('latestValuesFor', () => {
  it('returns the last non-null value per sensor', () => {
    const all = [
      series('VIN1', 'dynamic:battery.voltage', [
        [1, 12.0],
        [2, 12.4],
        [3, null],
      ]),
      series('VIN1', 'dynamic:battery.temp', [[1, 24]]),
      series('VIN1', 'dynamic:VELOCITY', [[1, 55]]),
    ];
    const values = latestValuesFor(all, 'battery');
    expect(values.get('battery.voltage')).toBe(12.4);
    expect(values.get('battery.temp')).toBe(24);
    expect(values.has('battery.soc')).toBe(false); // no series for this sensor
    expect(values.has('battery.current')).toBe(false);
  });

  it('returns raw string values when present (static readings)', () => {
    const all = [
      series('VIN1', 'static:make', [[1, null, 'Nexus SDV']]),
      series('VIN1', 'static:index', [[1, null, '42']]),
      series('VIN1', 'dynamic:battery.temp', [[1, 25]]),
    ];
    const cabin = latestValuesFor(all, 'cabin');
    expect(cabin.get('make')).toBe('Nexus SDV');
    expect(cabin.get('index')).toBe('42');
    expect(cabin.get('battery.temp')).toBe(25);
    const battery = latestValuesFor(all, 'battery');
    expect(battery.get('battery.temp')).toBe(25);
  });

  it('returns an empty map for an unknown component', () => {
    expect(latestValuesFor([], 'nope')).toEqual(new Map());
  });
});

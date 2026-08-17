import type { DemoControlReply } from '@/lib/demo-control';
import { columnQualifier, displayValueForColumn, type ChartSeries } from '@/lib/telemetry-chart-utils';

const WHEELS = ['FL', 'FR', 'RL', 'RR'] as const;

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nestedNumber(
  source: Record<string, unknown> | undefined,
  key: string,
): number | null {
  return finiteNumber(source?.[key]);
}

/**
 * Return the live simulator value for a telemetry column, when the control
 * snapshot carries that signal. Historical values remain untouched when the
 * simulator does not expose a matching field.
 */
export function liveValueForColumn(
  column: string,
  snapshot: DemoControlReply,
): number | null {
  const qualifier = columnQualifier(column);
  const live = snapshot.live as Record<string, unknown> | undefined;
  const groundTruth = snapshot.ground_truth;
  const tires = groundTruth?.tires;
  const brakes = groundTruth?.brakes;

  const direct: Record<string, unknown> = {
    'battery.voltage': live?.battery_voltage,
    'battery.current': live?.battery_current,
    'battery.soc': live?.battery_soc,
    'battery.temp': live?.battery_temp,
    VELOCITY: live?.velocity_m_s,
    TIRE_PRESSURE: live?.tire_pressure_bar ?? nestedNumber(tires, 'pressure_bar'),
    TIRE_TEMP: live?.tire_temp_c ?? nestedNumber(tires, 'temp_c'),
    GPS_LATITUDE: live?.lat,
    GPS_LONGITUDE: live?.lng,
    HEADING_DEG: live?.heading_deg,
    STEERING_ANGLE_DEG: live?.steering_angle_deg,
    ACCELERATOR_PEDAL_PCT: live?.accelerator_pedal_pct,
    BRAKE_PEDAL_PCT: live?.brake_pedal_pct,
    ENGINE_POWER: live?.engine_power,
    ENGINE_RPM: live?.engine_rpm,
    FUEL_CAPACITY: live?.fuel_capacity,
    FUEL_LEVEL: live?.fuel_level,
  };

  const aliases: Record<string, string> = {
    'gps.latitude': 'GPS_LATITUDE',
    'gps.longitude': 'GPS_LONGITUDE',
    velocity: 'VELOCITY',
  };
  const directKey = aliases[qualifier.toLowerCase()] ?? qualifier;
  if (directKey in direct) {
    const value = finiteNumber(direct[directKey]);
    return value === null ? null : displayValueForColumn(column, value);
  }
  for (const wheel of WHEELS) {
    const tireWheel = tires?.[wheel] as Record<string, unknown> | undefined;
    const brakeWheel = brakes?.[wheel] as Record<string, unknown> | undefined;
    const normalizedQualifier = qualifier.toUpperCase();
    if (normalizedQualifier === `TIRE_PRESSURE.${wheel}`) {
      return nestedNumber(tireWheel, 'pressure_bar');
    }
    if (normalizedQualifier === `TIRE_TEMP.${wheel}`) {
      return nestedNumber(tireWheel, 'temp_c');
    }
    if (normalizedQualifier === `BRAKE_WEAR.${wheel}`) {
      return nestedNumber(brakeWheel, 'wear_fraction');
    }
  }

  return null;
}

function snapshotTime(snapshot: DemoControlReply, fallbackAt?: number | null): number | null {
  const observed = snapshot.observed_at ? Date.parse(snapshot.observed_at) : NaN;
  if (Number.isFinite(observed)) return observed;
  return fallbackAt != null && Number.isFinite(fallbackAt) ? fallbackAt : null;
}

/**
 * Overlay the latest simulator frame onto historical/WebSocket series. The
 * point uses the simulator's observed_at timestamp, so every live signal is
 * rendered as one coherent frame instead of each chart stopping at a
 * different chart-service poll.
 */
export function mergeLiveSnapshot(
  series: ChartSeries[],
  snapshot: DemoControlReply | null | undefined,
  fallbackAt?: number | null,
): ChartSeries[] {
  if (!snapshot) return series;
  const x = snapshotTime(snapshot, fallbackAt);
  if (x === null) return series;

  return series.map((entry) => {
    if (entry.vin !== snapshot.vin || entry.column.startsWith('static:')) return entry;
    const value = liveValueForColumn(entry.column, snapshot);
    if (value === null) return entry;
    const point = { x, y: value };
    const existingIndex = entry.points.findIndex((candidate) => candidate.x === x);
    const points = [...entry.points];
    if (existingIndex >= 0) points[existingIndex] = point;
    else points.push(point);
    points.sort((a, b) => a.x - b.x);
    return { ...entry, points };
  });
}

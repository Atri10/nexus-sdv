import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import { qualifierOf } from '@/lib/telemetry-discovery';

/** One GPS fix: timestamp + coordinate pair. */
export interface GpsPoint {
  x: number;
  lat: number;
  lng: number;
}

const GPS_LAT = 'GPS_LATITUDE';
const GPS_LNG = 'GPS_LONGITUDE';

/** The lat/lng series among the given telemetry series, if present. */
export function gpsSeries(series: ChartSeries[]): { lat?: ChartSeries; lng?: ChartSeries } {
  return {
    lat: series.find((s) => qualifierOf(s.column) === GPS_LAT),
    lng: series.find((s) => qualifierOf(s.column) === GPS_LNG),
  };
}

/**
 * Zips the GPS_LATITUDE / GPS_LONGITUDE series into a coordinate trail by
 * timestamp. Points without a value (or without a matching lng fix) are
 * dropped; when capped at maxPoints the tail is kept so the map always
 * shows the most recent movement.
 */
export function gpsTrail(series: ChartSeries[], maxPoints = 600): GpsPoint[] {
  const { lat, lng } = gpsSeries(series);
  if (!lat || !lng) return [];
  const lngByX = new Map<number, number>();
  for (const p of lng.points) {
    if (p.y != null) lngByX.set(p.x, p.y);
  }
  const trail: GpsPoint[] = [];
  for (const p of lat.points) {
    if (p.y == null) continue;
    const lngValue = lngByX.get(p.x);
    if (lngValue == null) continue;
    trail.push({ x: p.x, lat: p.y, lng: lngValue });
  }
  return trail.length > maxPoints ? trail.slice(-maxPoints) : trail;
}

/** The most recent GPS fix, or null when no complete fix exists. */
export function latestGps(series: ChartSeries[]): GpsPoint | null {
  const trail = gpsTrail(series);
  return trail.length > 0 ? trail[trail.length - 1] : null;
}

import { describe, expect, it } from '@jest/globals';
import { gpsSeries, gpsTrail, latestGps, type GpsPoint } from '@/lib/gps-trail';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

const latSeries = (points: ChartSeries['points'], column = 'dynamic:GPS_LATITUDE'): ChartSeries => ({
  vin: 'VIN1001',
  column,
  key: `VIN1001|${column}`,
  label: 'GPS_LATITUDE',
  color: '#3B82F6',
  points,
});

describe('gps trail helpers', () => {
  it('returns empty trail when either series is missing', () => {
    expect(gpsTrail([])).toEqual([]);
    expect(gpsTrail([latSeries([{ x: 1, y: 10 }])])).toEqual([]);
  });

  it('zips lat/lng points by timestamp', () => {
    const trail = gpsTrail([
      latSeries([
        { x: 1, y: 10.1 },
        { x: 2, y: 10.2 },
      ]),
      latSeries(
        [
          { x: 1, y: 20.1 },
          { x: 2, y: 20.2 },
        ],
        'dynamic:GPS_LONGITUDE'
      ),
    ]);
    expect(trail).toEqual([
      { x: 1, lat: 10.1, lng: 20.1 },
      { x: 2, lat: 10.2, lng: 20.2 },
    ]);
  });

  it('drops points missing a value or an lng match', () => {
    const trail = gpsTrail([
      latSeries([
        { x: 1, y: 10.1 },
        { x: 2, y: null },
        { x: 3, y: 10.3 },
      ]),
      latSeries(
        [
          { x: 1, y: 20.1 },
          { x: 3, y: 20.3 },
        ],
        'dynamic:GPS_LONGITUDE'
      ),
    ]);
    expect(trail).toEqual([
      { x: 1, lat: 10.1, lng: 20.1 },
      { x: 3, lat: 10.3, lng: 20.3 },
    ]);
  });

  it('caps the trail at maxPoints keeping the tail', () => {
    const lat = latSeries([...Array(10)].map((_, i) => ({ x: i, y: 10 + i / 10 })));
    const lng = latSeries([...Array(10)].map((_, i) => ({ x: i, y: 20 + i / 10 })), 'dynamic:GPS_LONGITUDE');
    const trail = gpsTrail([lat, lng], 3);
    expect(trail).toHaveLength(3);
    expect(trail[0]).toEqual({ x: 7, lat: 10.7, lng: 20.7 });
  });

  it('latestGps returns the last trail point or null', () => {
    expect(latestGps([])).toBeNull();
    const lat = latSeries([{ x: 1, y: 10.1 }]);
    const lng = latSeries([{ x: 1, y: 20.1 }], 'dynamic:GPS_LONGITUDE');
    expect(latestGps([lat, lng])).toEqual({ x: 1, lat: 10.1, lng: 20.1 });
  });
});

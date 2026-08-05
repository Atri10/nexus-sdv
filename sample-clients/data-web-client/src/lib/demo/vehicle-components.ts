import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export interface DemoComponent {
  id: string;
  label: string;
  description: string;
  sensors: { qualifier: string; label: string; unit?: string }[];
}

/**
 * Interactive components shown on the /demo schematic. Sensor qualifiers are
 * the connector's Bigtable column qualifiers WITHOUT the family prefix
 * (series columns look like `dynamic:battery.voltage`); matching is done by
 * suffix so battery.* sensors survive the family prefix.
 */
export const DEMO_COMPONENTS: DemoComponent[] = [
  {
    id: 'battery',
    label: 'Battery',
    description: 'High-voltage traction battery',
    sensors: [
      { qualifier: 'battery.voltage', label: 'Voltage', unit: 'V' },
      { qualifier: 'battery.current', label: 'Current', unit: 'A' },
      { qualifier: 'battery.soc', label: 'SoC', unit: '%' },
      { qualifier: 'battery.temp', label: 'Temp', unit: '°C' },
    ],
  },
  {
    id: 'powertrain',
    label: 'Powertrain',
    description: 'Electric drive unit',
    sensors: [
      { qualifier: 'ENGINE_POWER', label: 'Power', unit: 'kW' },
      { qualifier: 'ENGINE_RPM', label: 'RPM', unit: 'rpm' },
      { qualifier: 'FUEL_LEVEL', label: 'Fuel', unit: '%' },
      { qualifier: 'FUEL_CAPACITY', label: 'Fuel capacity', unit: 'L' },
    ],
  },
  {
    id: 'chassis',
    label: 'Chassis / GPS',
    description: 'Motion, position and driver input',
    sensors: [
      { qualifier: 'VELOCITY', label: 'Velocity', unit: 'km/h' },
      { qualifier: 'GPS_LATITUDE', label: 'Latitude' },
      { qualifier: 'GPS_LONGITUDE', label: 'Longitude' },
      { qualifier: 'STEERING_ANGLE_DEG', label: 'Steering', unit: '°' },
      { qualifier: 'ACCELERATOR_PEDAL_PCT', label: 'Accelerator', unit: '%' },
      { qualifier: 'BRAKE_PEDAL_PCT', label: 'Brake', unit: '%' },
    ],
  },
  {
    id: 'cabin',
    label: 'Cabin',
    description: 'Comfort and vehicle identity',
    sensors: [
      { qualifier: 'battery.temp', label: 'Battery temp', unit: '°C' },
      { qualifier: 'make', label: 'Make' },
      { qualifier: 'index', label: 'Model index' },
    ],
  },
];

/** Series whose column qualifier (after "family:") matches the component's sensor list. */
export function seriesForComponent(series: ChartSeries[], componentId: string): ChartSeries[] {
  const comp = DEMO_COMPONENTS.find((c) => c.id === componentId);
  if (!comp) return [];
  const qualifiers = new Set(comp.sensors.map((s) => s.qualifier));
  return series.filter((s) => {
    const colon = s.column.indexOf(':');
    const q = colon > -1 ? s.column.slice(colon + 1) : s.column;
    return qualifiers.has(q);
  });
}

export function latestValuesFor(series: ChartSeries[], componentId: string): Map<string, number | string> {
  const comp = DEMO_COMPONENTS.find((c) => c.id === componentId);
  if (!comp) return new Map();
  const out = new Map<string, number | string>();
  for (const sensor of comp.sensors) {
    const match = series.find((s) => {
      const colon = s.column.indexOf(':');
      return (colon > -1 ? s.column.slice(colon + 1) : s.column) === sensor.qualifier;
    });
    if (!match) continue;
    const last = [...match.points].reverse().find((p) => p.y != null);
    if (last?.y != null) out.set(sensor.qualifier, last.y);
  }
  return out;
}

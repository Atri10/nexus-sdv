import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export interface DemoComponent {
  id: string;
  label: string;
  description: string;
  sensors: { qualifier: string; label: string; unit?: string }[];
}

/**
 * Shared component metadata: the interactive /demo schematic and the 3D
 * device scene both derive their component lists from this single source.
 * Sensor qualifiers are the connector's Bigtable column qualifiers WITHOUT
 * the family prefix (series columns look like `dynamic:battery.voltage`);
 * matching is done by suffix so battery.* sensors survive the family prefix.
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

/**
 * 3D zone geometry for the device scene — one translucent box per component,
 * aligned to the procedural VehicleModel (unit scale) in scene coordinates.
 * `position` is the box center, `size` is [width, height, depth].
 */
export interface ComponentZone {
  id: string;
  label: string;
  position: [number, number, number];
  size: [number, number, number];
  color: string; // cyan-ish emissive
}

export const COMPONENT_ZONES: ComponentZone[] = [
  { id: 'battery', label: 'Battery', position: [0, 0.25, 1.0], size: [1.2, 0.35, 0.9], color: '#22D3EE' },
  { id: 'powertrain', label: 'Powertrain', position: [0, 0.35, -0.9], size: [0.9, 0.4, 0.7], color: '#22C55E' },
  { id: 'chassis', label: 'Chassis', position: [0, 0.1, 0], size: [1.5, 0.2, 2.6], color: '#8B5CF6' },
  { id: 'cabin', label: 'Cabin', position: [0, 0.9, -0.2], size: [1.0, 0.55, 1.2], color: '#F59E0B' },
];

/** Series whose column qualifier (after "family:") matches the component's sensor list. */
export function seriesForComponent(series: ChartSeries[], componentId: string): ChartSeries[] {
  const comp = DEMO_COMPONENTS.find((c) => c.id === componentId);
  if (!comp) return [];
  // Static sensor table from DEMO_COMPONENTS → Record membership check.
  const qualifiers = Object.fromEntries(comp.sensors.map((s) => [s.qualifier, true])) as Record<string, true>;
  return series.filter((s) => {
    const colon = s.column.indexOf(':');
    const q = colon > -1 ? s.column.slice(colon + 1) : s.column;
    return qualifiers[q] === true;
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
    const last = [...match.points].reverse().find((p) => p.y != null || p.raw != null);
    if (!last) continue;
    if (last.raw != null) out.set(sensor.qualifier, last.raw);
    else if (last.y != null) out.set(sensor.qualifier, last.y);
  }
  return out;
}

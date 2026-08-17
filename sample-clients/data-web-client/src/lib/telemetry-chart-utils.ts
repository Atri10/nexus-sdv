import { unitForQualifier } from '@/lib/vehicle-components';

export interface ChartSeries {
  vin: string;
  column: string;
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number | null; raw?: string }[];
  /** Render discrete detector updates as an honest step function. */
  stepped?: boolean | 'before' | 'after' | 'middle';
}

const VIN_FAMILIES = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];
const FAMILY_SHADES = ['', '99', '66', '33'];

export function vinColorFamily(vinIndex: number, seriesIndexInVin: number): string {
  const base = VIN_FAMILIES[vinIndex % VIN_FAMILIES.length];
  return base + FAMILY_SHADES[seriesIndexInVin % FAMILY_SHADES.length];
}

export function formatValue(v: number): string {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 100) {
    return Math.round(v).toLocaleString();
  }
  return v.toFixed(2);
}

function magnitude(s: ChartSeries): number {
  const max = s.points.reduce((m, p) => (p.y != null && Math.abs(p.y) > m ? Math.abs(p.y) : m), 0);
  return max || 1;
}

export function groupAxes(series: ChartSeries[]): { left: string[]; right: string[] } {
  const mags = series.map(magnitude);
  const left: string[] = [];
  const right: string[] = [];
  series.forEach((s, i) => {
    const isPercent = mags[i] <= 100 && mags[i] >= 0;
    const hasLarger = mags.some((m, j) => j !== i && m > 5 * mags[i]);
    if (isPercent && hasLarger) right.push(s.key);
    else left.push(s.key);
  });
  return { left, right };
}

/** Column qualifier without the family prefix ('dynamic:battery.voltage' → 'battery.voltage'). */
export function columnQualifier(column: string): string {
  const colon = column.indexOf(':');
  return colon > -1 ? column.slice(colon + 1) : column;
}

/**
 * Convert stored engineering units into the units shown by the dashboard.
 * VELOCITY is persisted and published by the vehicle in m/s, while the
 * dashboard's shared metadata presents it as km/h.
 */
export function displayValueForColumn(column: string, value: number): number {
  return columnQualifier(column).toUpperCase() === 'VELOCITY' ? value * 3.6 : value;
}

/**
 * Unit lookup for chart series: maps each series key to the unit declared in
 * the shared component metadata (DEMO_COMPONENTS), keyed by column qualifier.
 * Only series with a declared unit appear — GPS/static series are omitted.
 * Consumers use the map for axis titles and tooltip suffixes.
 */
export function unitsForSeries(series: ChartSeries[]): Record<string, string> {
  const units: Record<string, string> = {};
  for (const s of series) {
    const unit = unitForQualifier(columnQualifier(s.column));
    if (unit) units[s.key] = unit;
  }
  return units;
}

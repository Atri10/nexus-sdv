export interface ChartSeries {
  vin: string;
  column: string;
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number | null }[];
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
/**
 * Stable y-axis range for a single-signal chart: the full history's min/max
 * padded by 12%, so the axis only expands when a new extreme arrives instead
 * of rescaling on every tick (which makes live lines jump around the card).
 */
export interface AxisRange {
  min: number;
  max: number;
}

export function stableAxisRange(points: { y: number | null | undefined }[]): AxisRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.y == null || !Number.isFinite(p.y)) continue;
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  let span = max - min;
  if (span === 0) span = Math.max(Math.abs(max) * 0.05, 1); // constant signal: still show a window
  const pad = span * 0.12;
  return { min: min - pad, max: max + pad };
}

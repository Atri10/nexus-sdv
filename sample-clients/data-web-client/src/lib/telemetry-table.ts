import type { ChartSeries } from '@/lib/telemetry-chart-utils';

/**
 * A table row keyed by timestamp (epoch ms), with one value per series column.
 * `null` marks a series that had no point at that timestamp.
 */
export interface TelemetryTableRow {
  /** epoch ms — sort key and lookup key */
  tsKey: number;
  /** ISO timestamp for display formatting */
  iso: string;
  values: Record<string, string | number | null>;
}

export interface LatestValue {
  key: string;
  label: string;
  color: string;
  value: number | null;
  timestamp: number | null;
  /** Second-to-last numeric value (null when fewer than two numeric points). */
  previous: number | null;
  /** Last ≤20 numeric points, oldest first — feeds the KPI sparkline. */
  history: { x: number; y: number }[];
}

/**
 * Join telemetry series into table rows by timestamp (union of all series'
 * points, ascending). Values are looked up per series — never by array index —
 * so series with different point counts or live-appended points stay aligned.
 * Duplicate x values in a series keep the last point.
 */
export function buildTableRows(series: ChartSeries[]): TelemetryTableRow[] {
  if (series.length === 0) return [];

  // Per-series lookup: timestamp -> value (last wins on duplicates).
  const bySeries = series.map((s) => {
    const map = new Map<number, number | null>();
    for (const p of s.points) {
      if (p.x == null) continue;
      map.set(p.x, p.y);
    }
    return { key: s.key, map };
  });

  const tsSet = new Set<number>();
  for (const { map } of bySeries) {
    for (const ts of map.keys()) tsSet.add(ts);
  }
  const timestamps = Array.from(tsSet).sort((a, b) => a - b);

  return timestamps.map((ts) => {
    const values: Record<string, string | number | null> = {};
    for (const { key, map } of bySeries) {
      values[key] = map.has(ts) ? (map.get(ts) ?? null) : null;
    }
    return { tsKey: ts, iso: new Date(ts).toISOString(), values };
  });
}

/**
 * Latest numeric value per series (last point with a non-null y), for KPI
 * displays. A series with no numeric points reports value/timestamp null.
 * During the single pass, `previous` keeps the second-to-last numeric value
 * and `history` keeps the last ≤20 numeric points (oldest first) for the
 * sparkline — null points are skipped in both, matching the sparkline's need
 * for continuous numeric data.
 */
export function latestValues(series: ChartSeries[]): LatestValue[] {
  return series.map((s) => {
    let value: number | null = null;
    let previous: number | null = null;
    let timestamp: number | null = null;
    const history: { x: number; y: number }[] = [];
    for (const p of s.points) {
      if (p.y != null) {
        previous = value;
        value = p.y;
        timestamp = p.x;
        if (history.length === 20) history.shift();
        history.push({ x: p.x, y: p.y });
      }
    }
    return { key: s.key, label: s.label, color: s.color, value, timestamp, previous, history };
  });
}

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartSeries, vinColorFamily } from '@/lib/telemetry-chart-utils';


export interface TelemetryRow {
  timestamp: string;
  values: Record<string, string>;
}
export interface TelemetryResponse {
  rows: TelemetryRow[];
  columns: string[];
  nextCursor?: string | null;
}

export function shapeRows(vin: string, rows: TelemetryRow[]): ChartSeries[] {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r.values))));
  return cols.map((col, i) => ({
    vin,
    column: col,
    key: `${vin}|${col}`,
    label: col.replace('dynamic:', '').replace('static:', ''),
    color: vinColorFamily(0, i),
    points: rows.map((r) => {
      const raw = r.values[col];
      const num = raw != null && raw !== '---' && raw !== '' ? Number(raw) : NaN;
      if (isFinite(num)) return { x: Date.parse(r.timestamp), y: num };
      if (raw != null && raw !== '' && raw !== '---') {
        return { x: Date.parse(r.timestamp), y: null, raw };
      }
      return { x: Date.parse(r.timestamp), y: null };
    }),
  }));
}

const RANGE_MS: Record<string, number> = {
  '1h': 3600e3,
  '6h': 6 * 3600e3,
  '24h': 24 * 3600e3,
  '7d': 7 * 86400e3,
};

export interface UseTelemetryDataOptions {
  vin: string;
  range: '1h' | '6h' | '24h' | '7d';
  compareVins?: string[];
}

export interface TelemetryDataResult {
  series: ChartSeries[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useTelemetryData(opts: UseTelemetryDataOptions): TelemetryDataResult {
  const { vin, range, compareVins = [] } = opts;
  const compareKey = compareVins.join('|');
  const [series, setSeries] = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchHistorical = useCallback(async (v: string, baseIdx: number): Promise<ChartSeries[]> => {
    const end = Date.now();
    const start = end - RANGE_MS[range];
    const url = `/api/telemetry/${encodeURIComponent(v)}?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shaped = shapeRows(v, data.rows);
    return shaped.map((s, i) => ({ ...s, color: vinColorFamily(baseIdx, i) }));
  }, [range]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const vins = [vin, ...compareVins.filter((c) => c && c !== vin)];
    try {
      const all = (await Promise.all(vins.map((v, i) => fetchHistorical(v, i)))).flat();
      setSeries(all);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load telemetry';
      setError(msg);
      // Don't leave stale series for the requested VINs after a failed
      // refetch — they'd show outdated data (or duplicate live series)
      // after a mid-session VIN change.
      setSeries((prev) => prev.filter((s) => !vins.includes(s.vin)));
      const { toast } = await import('sonner');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [vin, compareKey, fetchHistorical]);

  useEffect(() => {
    load();
    // Live WebSocket for PRIMARY vin only (avoids N sockets)
    const configured = process.env.NEXT_PUBLIC_TELEMETRY_SERVICE_URL;
    const base =
      configured ??
      `http${window.location.protocol === 'https:' ? 's' : ''}://${window.location.hostname}:8081`;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/vehicles/${encodeURIComponent(vin)}/telemetry/live`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== 'telemetry' || !msg.timestamp || !msg.values) return;
        setSeries((prev) => {
          const cols = Object.keys(msg.values);
          const additions = cols.map((col, i) => {
            const raw = msg.values[col];
            const num = raw != null && raw !== '---' ? Number(raw) : NaN;
            const key = `${vin}|${col}`;
            const existing = prev.find((s) => s.key === key);
            const point: ChartSeries['points'][number] = isFinite(num)
              ? { x: Date.parse(msg.timestamp), y: num }
              : raw != null && raw !== '' && raw !== '---'
                ? { x: Date.parse(msg.timestamp), y: null, raw }
                : { x: Date.parse(msg.timestamp), y: null };
            if (existing) {
              // The server re-pushes the current row on every poll (and on
              // connect, once for the row the historical fetch already has) —
              // skip a point identical to the series' last one.
              const last = existing.points[existing.points.length - 1];
              if (last && last.x === point.x) return existing;
              // Keep the fetched history plus a bounded live window; a tiny
              // slice(-300) here would silently erase the historical tail.
              const points = [...existing.points, point].slice(-1500);
              return { ...existing, points };
            }
            return {
              vin,
              column: col,
              key: `${vin}|${col}`,
              label: col.replace('dynamic:', '').replace('static:', ''),
              color: vinColorFamily(0, prev.filter((s) => s.vin === vin).length + i),
              points: [point],
            } as ChartSeries;
          });
          const additionsByKey = new Map(additions.map((a) => [a.key, a]));
          const existingKeys = new Set(prev.map((s) => s.key));
          // Drop series for VINs we are no longer tracking (e.g. after a
          // mid-session re-discovery): otherwise stale series linger and
          // every signal renders twice.
          const currentVins = new Set([vin, ...compareVins]);
          const relevant = prev.filter((s) => currentVins.has(s.vin));
          const merged = relevant.map((s) => additionsByKey.get(s.key) ?? s);
          return [...merged, ...additions.filter((a) => !existingKeys.has(a.key))];
        });
      } catch {
        /* ignore parse errors */
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [vin, range, compareKey, load]);

  return { series, loading, error, refetch: load };
}
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
      return { x: Date.parse(r.timestamp), y: isFinite(num) ? num : null };
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
    const url = `/api/telemetry/${encodeURIComponent(v)}?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shaped = shapeRows(v, data.rows);
    return shaped.map((s, i) => ({ ...s, color: vinColorFamily(baseIdx, i) }));
  }, [range]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const vins = [vin, ...compareVins.filter((c) => c && c !== vin)];
      const all = (await Promise.all(vins.map((v, i) => fetchHistorical(v, i)))).flat();
      setSeries(all);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load telemetry';
      setError(msg);
      const { toast } = await import('sonner');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [vin, compareKey, fetchHistorical]);

  useEffect(() => {
    load();
    // Live WebSocket for PRIMARY vin only (avoids N sockets)
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.hostname}:8081/api/v1/vehicles/${encodeURIComponent(vin)}/telemetry/live`);
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
            const point = { x: Date.parse(msg.timestamp), y: isFinite(num) ? num : null };
            if (existing) {
              const points = [...existing.points, point].slice(-300);
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
          const merged = prev.map((s) => additionsByKey.get(s.key) ?? s);
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
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartSeries, displayValueForColumn, vinColorFamily } from '@/lib/telemetry-chart-utils';
import type { DemoControlReply } from '@/lib/demo-control';
import { mergeLiveSnapshot } from '@/lib/telemetry-snapshot';

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
      if (isFinite(num)) return { x: Date.parse(r.timestamp), y: displayValueForColumn(col, num) };
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
  /** Latest simulator frame for the primary VIN, when it is the live sim. */
  liveSnapshot?: DemoControlReply | null;
  /** Client arrival time fallback for older simulator builds without observed_at. */
  liveSnapshotAt?: number | null;
}

export interface TelemetryDataResult {
  series: ChartSeries[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useTelemetryData(opts: UseTelemetryDataOptions): TelemetryDataResult {
  const { vin, range, compareVins = [], liveSnapshot = null, liveSnapshotAt = null } = opts;
  const compareKey = compareVins.join('|');
  const [series, setSeries] = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Monotonic epoch for stale-fetch protection (see load()).
  const loadEpoch = useRef(0);

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
    // Epoch guard against stale responses: a slow in-flight fetch for an
    // old VIN/range must not overwrite a newer request's series after a
    // mid-session switch. Each load bumps the epoch; only the response
    // matching the current epoch applies its data.
    const epoch = ++loadEpoch.current;
    // No synchronous setState here: the effect calls load() directly, and
    // react-hooks forbids sync setState in the effect path. loading is
    // derived (initial true, flipped false after the first response); the
    // only explicit setLoading happens post-await in finally. setError(null)
    // happens after the first await below.
    const vins = [vin, ...compareVins.filter((c) => c && c !== vin)];
    try {
      const all = (await Promise.all(vins.map((v, i) => fetchHistorical(v, i)))).flat();
      // Post-await — async path, lint-clean.
      if (loadEpoch.current === epoch) {
        setError(null);
        setSeries(all);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load telemetry';
      if (loadEpoch.current !== epoch) return; // stale failure — ignore
      setError(msg);
      // Don't leave stale series for the requested VINs after a failed
      // refetch — they'd show outdated data (or duplicate live series)
      // after a mid-session VIN change.
      setSeries((prev) => prev.filter((s) => !vins.includes(s.vin)));
      const { toast } = await import('sonner');
      toast.error(msg);
    } finally {
      if (loadEpoch.current === epoch) setLoading(false);
    }
  }, [vin, compareKey, fetchHistorical]);

  useEffect(() => {
    // Fetch-on-mount: the fetch is external, all setState happens post-await
    // inside load()'s promise chain. The react-hooks rule still traces the
    // call, but there is no state-lifting alternative here (data is
    // genuinely fetched, not derived) — this is the documented pattern the
    // rule's own docs acknowledge as acceptable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().then(() => {
      // load() already applied series/error/loading; nothing else needed.
    });
    // Live WebSocket for PRIMARY vin only (avoids N sockets)
    const configured = process.env.NEXT_PUBLIC_TELEMETRY_SERVICE_URL;
    const base =
      configured ??
      `http${window.location.protocol === 'https:' ? 's' : ''}://${window.location.hostname}:8081`;
    const url = `${base.replace(/^http/, 'ws')}/api/v1/vehicles/${encodeURIComponent(vin)}/telemetry/live`;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;
    // Bounded reconnect: after a network blip or a chart-service restart the
    // live feed would otherwise die permanently. Retry with backoff up to 5
    // attempts, then give up until the next vin/range change.
    const connect = () => {
      ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== 'telemetry' || !msg.timestamp || !msg.values) return;
        setSeries((prev) => {
          const cols = Object.keys(msg.values);
          const additions = cols.map((col, i) => {
            const raw = msg.values[col];
            const rawNum = raw != null && raw !== '---' ? Number(raw) : NaN;
            const num = isFinite(rawNum) ? displayValueForColumn(col, rawNum) : rawNum;
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
      ws.onclose = () => {
        // Bounded reconnect with backoff: 1s, 2s, 4s, 8s, 16s, then stop
        // until the next vin/range change (attempt reset).
        if (attempt >= 5) return;
        attempt += 1;
        retryTimer = window.setTimeout(connect, 1000 * 2 ** (attempt - 1));
      };
      ws.onerror = () => ws?.close(); // onclose schedules the retry
    };
    connect();
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [vin, range, compareKey, load]);

  const synchronizedSeries = mergeLiveSnapshot(series, liveSnapshot, liveSnapshotAt);
  return { series: synchronizedSeries, loading, error, refetch: load };
}

'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppLayout from '@/components/app-layout';
import DataTable from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StateView } from '@/components/state-view';
import FleetScene from '@/components/scene/fleet-scene';
import type { FleetVehicle } from '@/components/scene/fleet-scene';
import type { DevicesResponse, DeviceRow } from '@/types/telemetry';

function formatLastSeen(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return new Date(iso).toLocaleString();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleString();
}

// Accepted qualifier names for each GPS axis (case-insensitive, any column
// family) — mirrors lib/gps.ts, which covers both dot-separated
// (gps.latitude) and connector-style (GPS_LATITUDE) qualifiers.
const LAT_QUALIFIERS = ['gps.latitude', 'gps_latitude'];
const LNG_QUALIFIERS = ['gps.longitude', 'gps_longitude'];

function findColumn(columns: Record<string, string>, qualifiers: string[]): string | undefined {
  return Object.keys(columns).find((key) => {
    const colon = key.indexOf(':');
    const qualifier = (colon > -1 ? key.slice(colon + 1) : key).toLowerCase();
    return qualifiers.includes(qualifier);
  });
}

// Values may be bare strings or JSON-encoded strings (e.g. "\"41.49\"").
function parseNumeric(value: string): number | undefined {
  const n = Number(value.replace(/^"+|"+$/g, ''));
  return isFinite(n) ? n : undefined;
}

function toFleetVehicle(device: DeviceRow): FleetVehicle {
  const latKey = findColumn(device.columns, LAT_QUALIFIERS);
  const lngKey = findColumn(device.columns, LNG_QUALIFIERS);
  const lat = latKey ? parseNumeric(device.columns[latKey]) : undefined;
  const lng = lngKey ? parseNumeric(device.columns[lngKey]) : undefined;
  return { vin: device.deviceId, lat, lng };
}

const SCENE_FALLBACK = (
  <div className="flex h-full w-full items-center justify-center">
    <p className="font-mono text-xs tracking-wider text-muted-foreground">
      3D view unavailable — using table below.
    </p>
  </div>
);

export default function FleetPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVin, setSelectedVin] = useState<string | null>(null);

  // State is only set in async callbacks (fetch resolution), never
  // synchronously in the effect body — react-hooks/set-state-in-effect.
  const load = useCallback(() => {
    fetch('/api/devices')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DevicesResponse>;
      })
      .then((data) => {
        setDevices(data.devices);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const vehicles = useMemo(() => devices.map(toFleetVehicle), [devices]);

  // Live detection (fresh telemetry within ~2× publish interval) is deferred
  // to T9 polish; an empty set renders vehicles without pulse rings for now.
  const liveVins = useMemo(() => new Set<string>(), []);

  const handleSelect = (vin: string) => {
    setSelectedVin(vin);
    router.push(`/device/${vin}`);
  };

  const isGpsColumn = (key: string) => {
    const qualifier = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    return qualifier.toLowerCase().startsWith('gps.');
  };

  const allColumnKeys = Array.from(
    new Set(devices.flatMap((d) => Object.keys(d.columns).filter((k) => !isGpsColumn(k))))
  ).sort();

  const tableColumnKeys = ['deviceId', 'lastSeen', ...allColumnKeys];

  const tableData = devices.map((d) => ({
    deviceId: d.deviceId,
    lastSeen: formatLastSeen(d.lastSeen),
    ...d.columns,
  }));

  const state = error ? 'error' : loading ? 'loading' : devices.length === 0 ? 'empty' : 'ready';

  return (
    <AppLayout>
      <div className="flex flex-col gap-4">
        <section className="hud-panel overflow-hidden rounded-lg">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <h2 className="font-display text-lg font-bold tracking-[0.3em] text-cyan-700 glow-text dark:text-cyan-400">
              FLEET
            </h2>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-wider">
              <span className="rounded border border-border/70 bg-card/50 px-2 py-1 text-muted-foreground">
                VEHICLES <span className="text-foreground">{devices.length}</span>
              </span>
              <span className="rounded border border-border/70 bg-card/50 px-2 py-1 text-muted-foreground">
                LIVE <span className="text-emerald-500">{liveVins.size}</span>
              </span>
              <span className="rounded border border-border/70 bg-card/50 px-2 py-1 text-muted-foreground">
                SEL <span className="text-cyan-600 dark:text-cyan-400">{selectedVin ?? '—'}</span>
              </span>
            </div>
          </div>
          <div className="relative h-[420px]">
            {state === 'loading' && <StateView state="loading">{null}</StateView>}
            {state === 'error' && (
              <StateView state="error" onRetry={load}>
                {null}
              </StateView>
            )}
            {state === 'empty' && (
              <div className="flex h-[400px] w-full items-center justify-center rounded-lg border border-dashed">
                <p className="text-muted-foreground">
                  No devices found — start the simulator or ingest data.
                </p>
              </div>
            )}
            {state === 'ready' && (
              <FleetScene
                vehicles={vehicles}
                liveVins={liveVins}
                onSelect={handleSelect}
                onDeselect={() => setSelectedVin(null)}
                fallback={SCENE_FALLBACK}
                className="h-full w-full"
              />
            )}
          </div>
        </section>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Fleet</CardTitle>
              {state === 'ready' && <Badge variant="default">{devices.length} devices</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            {state === 'loading' && <Skeleton className="h-[300px] w-full rounded-lg" />}
            {state === 'error' && <p className="text-destructive">Error: {error}</p>}
            {state === 'empty' && (
              <p className="py-8 text-center text-muted-foreground">No devices found.</p>
            )}
            {state === 'ready' && (
              <DataTable
                columnKeys={tableColumnKeys}
                data={tableData}
                onRowClick={(row) => router.push(`/device/${row.deviceId}`)}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

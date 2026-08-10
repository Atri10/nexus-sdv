'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppLayout from '@/components/app-layout';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FadeIn } from '@/components/motion/fade-in';
import { usePmMessages } from '@/hooks/usePmMessages';
import { severityColor, type PmMessage } from '@/lib/pm-types';

type Vehicle = {
  deviceId: string;
  lastSeen: string;
  columns: Record<string, string>;
};

/**
 * Simple live Predictive-Maintenance board.
 *
 * One table of vehicles (VIN, status, speed, battery voltage, health score,
 * last alert) that updates every few seconds from the telemetry API, plus a
 * live alert ticker on top fed by the pm.* NATS stream. No drill-down, no
 * matrix, no validation card — just "is my vehicle progressing and is PM
 * firing".
 */
export default function PmPage() {
  const messages = usePmMessages();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);

  const loadVehicles = useCallback(() => {
    fetch('/api/devices')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ devices: Vehicle[] }>;
      })
      .then((d) => setVehicles(d.devices))
      .catch((e: unknown) => console.error('load vehicles', e))
      .finally(() => setLoading(false));
  }, []);

  // Refresh the vehicle list every 5s so speed/voltage/health stay live.
  useEffect(() => {
    loadVehicles();
    const id = setInterval(loadVehicles, 5000);
    return () => clearInterval(id);
  }, [loadVehicles]);

  // Latest pm message per VIN (newest-first input).
  const latestByVin = useMemo(() => {
    const m = new Map<string, PmMessage>();
    for (const msg of messages) if (!m.has(msg.vin)) m.set(msg.vin, msg);
    return m;
  }, [messages]);

  const alertCount = messages.length;
  const criticalCount = messages.filter((m) => m.severity === 'critical').length;

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Predictive Maintenance — Live</h1>
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground">
            <span className="rounded border border-border/70 bg-card/50 px-2 py-1">
              VEHICLES <span className="text-foreground">{vehicles.length}</span>
            </span>
            <span className="rounded border border-border/70 bg-card/50 px-2 py-1">
              ALERTS <span className="text-foreground">{alertCount}</span>
            </span>
            <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-600">
              CRITICAL <span className="font-semibold">{criticalCount}</span>
            </span>
          </div>
        </div>

        {/* Live alert ticker */}
        <FadeIn>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Live alerts</CardTitle>
            </CardHeader>
            <CardContent>
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No alerts yet — the simulator is backfilling history and the detector will
                  start firing within a minute.
                </p>
              ) : (
                <div className="max-h-40 space-y-1.5 overflow-y-auto">
                  {messages.slice(0, 15).map((m, i) => (
                    <div key={`${m.timestamp}-${m.vin}-${i}`} className="flex items-start gap-2 text-sm">
                      <Badge
                        className="shrink-0 font-mono text-[10px] uppercase tracking-wider"
                        style={{ backgroundColor: `${severityColor(m.severity)}26`, color: severityColor(m.severity) }}
                      >
                        {m.severity}
                      </Badge>
                      <span className="font-mono text-xs text-foreground/90">{m.vin}</span>
                      <span className="font-mono text-xs text-muted-foreground">{m.component}</span>
                      <span className="text-foreground/85">{m.explanation}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </FadeIn>

        {/* Live vehicle table */}
        <FadeIn>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Fleet status</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Loading fleet…</p>
              ) : vehicles.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No vehicles with telemetry yet — the simulator publishes once the stack is up.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-3">Vehicle</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Speed</th>
                        <th className="py-2 pr-3">Battery</th>
                        <th className="py-2 pr-3">Health</th>
                        <th className="py-2">Last alert</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vehicles.map((v) => {
                        const pm = latestByVin.get(v.deviceId);
                        const speed = parseFloat(v.columns['dynamic:VELOCITY'] ?? '0');
                        const batteryV = parseFloat(v.columns['dynamic:battery.voltage'] ?? '0');
                        const lastSeen = v.lastSeen ? new Date(v.lastSeen).toLocaleTimeString() : '—';
                        return (
                          <tr key={v.deviceId} className="border-b border-border/40">
                            <td className="py-2 pr-3 font-mono text-xs">{v.deviceId}</td>
                            <td className="py-2 pr-3">
                              <span
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ backgroundColor: pm ? severityColor(pm.severity) : '#22C55E' }}
                              />
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs">{speed.toFixed(1)} km/h</td>
                            <td className="py-2 pr-3 font-mono text-xs">{batteryV ? batteryV.toFixed(2) : '—'} V</td>
                            <td className="py-2 pr-3">
                              {pm ? (
                                <span className="font-mono text-xs" style={{ color: severityColor(pm.severity) }}>
                                  {pm.health_score}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="py-2 text-xs text-muted-foreground">
                              {pm ? (
                                <>
                                  <span className="font-mono" style={{ color: severityColor(pm.severity) }}>
                                    {pm.severity}
                                  </span>{' '}
                                  · {pm.component} · {lastSeen}
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </FadeIn>
      </div>
    </AppLayout>
  );
}

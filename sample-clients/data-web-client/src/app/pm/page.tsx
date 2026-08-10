'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppLayout from '@/components/app-layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FadeIn } from '@/components/motion/fade-in';
import { usePmMessages } from '@/hooks/usePmMessages';
import { severityColor, type PmMessage } from '@/lib/pm-types';
import {
  PM_COMPONENTS,
  PmHealthMatrix,
  type PmComponent,
} from '@/components/pm/pm-health-matrix';
import { PmAlertFeed } from '@/components/pm/pm-alert-feed';
import { PmDrillDown } from '@/components/pm/pm-drill-down';
import type { DevicesResponse, DeviceRow } from '@/types/telemetry';

export const SEVERITIES = ['healthy', 'advisory', 'action', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface PmValidationData {
  generated?: string;
  simulated_vins?: number;
  /** True when the numbers are placeholders (no real evaluator run yet). The
   * file self-identifies so it can't be mistaken for real validation. */
  placeholder?: boolean;
  components: Partial<Record<PmComponent, { precision: number; recall: number; mean_lead_days: number }>>;
}

/** Counts per severity for one component across the fleet (latest msg per VIN). */
export function severityCounts(messages: PmMessage[], component: PmComponent): Record<Severity, number> {
  const byVin = new Map<string, PmMessage>();
  for (const m of messages) {
    if (m.component !== component) continue;
    if (!byVin.has(m.vin)) byVin.set(m.vin, m);
  }
  const counts: Record<Severity, number> = { healthy: 0, advisory: 0, action: 0, critical: 0 };
  for (const m of byVin.values()) counts[m.severity] += 1;
  return counts;
}

/** Validation card: reads public/pm-validation.json (initial values; the
 * evaluator replaces them in Task 9) and renders the precision/recall/lead
 * table per component. */
export function PmValidationCard() {
  const [data, setData] = useState<PmValidationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/pm-validation.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: PmValidationData) => {
        setData(json);
        setError(null);
      })
      .catch((e: unknown) => {
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Validation</CardTitle>
          <CardDescription>Simulator ground truth</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Could not load pm-validation.json ({error}).</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Validation</CardTitle>
          <Badge variant={data?.placeholder ? 'secondary' : 'outline'} className="font-mono text-[10px] uppercase tracking-wider">
            {data?.placeholder ? 'placeholder' : 'simulator ground truth'}
          </Badge>
        </div>
        <CardDescription>
          Detector precision / recall / mean lead time vs the simulator.
          {data?.placeholder
            ? ' Placeholder values — the file self-identifies until a real evaluator run replaces them.'
            : ' Measured against simulator ground truth from the last evaluator run.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-1.5 pr-2">Component</th>
                <th className="pb-1.5 pr-2 text-right">Precision</th>
                <th className="pb-1.5 pr-2 text-right">Recall</th>
                <th className="pb-1.5 text-right">Mean lead (days)</th>
              </tr>
            </thead>
            <tbody>
              {PM_COMPONENTS.map((c) => {
                const v = data.components?.[c];
                return (
                  <tr key={c} className="border-b border-border/30">
                    <td className="py-1.5 pr-2 font-mono text-foreground/90">{c}</td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-foreground/85">
                      {v ? v.precision.toFixed(2) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-foreground/85">
                      {v ? v.recall.toFixed(2) : '—'}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-foreground/85">
                      {v ? v.mean_lead_days : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data?.simulated_vins !== undefined && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {data.simulated_vins} simulated VINs · generated {data.generated ?? '—'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Fleet-health overview card: latest health counts per component, broken
 * down by severity band (from the live pm.* stream via usePmMessages). */
function OverviewCard({ component, messages }: { component: PmComponent; messages: PmMessage[] }) {
  const counts = useMemo(() => severityCounts(messages, component), [messages, component]);
  const total = SEVERITIES.reduce((sum, sev) => sum + counts[sev], 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-mono text-sm capitalize">{component}</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            {total} tracked
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {total > 0 &&
            (['critical', 'action', 'advisory', 'healthy'] as const).map((sev) =>
              counts[sev] > 0 ? (
                <div
                  key={sev}
                  className="h-full"
                  style={{ width: `${(counts[sev] / total) * 100}%`, backgroundColor: severityColor(sev) }}
                  title={`${sev}: ${counts[sev]}`}
                />
              ) : null
            )}
        </div>
        <dl className="mt-3 grid grid-cols-4 gap-1 text-center">
          {(['healthy', 'advisory', 'action', 'critical'] as const).map((sev) => (
            <div key={sev}>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {sev}
              </dt>
              <dd className="font-mono text-lg font-semibold tabular-nums" style={{ color: severityColor(sev) }}>
                {counts[sev]}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default function PmPage() {
  const messages = usePmMessages();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ vin: string; component: PmComponent } | null>(null);

  const loadDevices = useCallback(() => {
    fetch('/api/devices')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DevicesResponse>;
      })
      .then((data) => {
        setDevices(data.devices);
        setDevicesError(null);
        setDevicesLoading(false);
      })
      .catch((e: unknown) => {
        setDevicesError(e instanceof Error ? e.message : String(e));
        setDevicesLoading(false);
      });
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const vins = useMemo(() => devices.map((d) => d.deviceId), [devices]);

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Predictive Maintenance</h1>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground">
            <span className="rounded border border-border/70 bg-card/50 px-2 py-1">
              VEHICLES <span className="text-foreground">{vins.length}</span>
            </span>
            <span className="rounded border border-border/70 bg-card/50 px-2 py-1">
              MESSAGES <span className="text-foreground">{messages.length}</span>
            </span>
          </div>
        </div>

        <FadeIn>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {PM_COMPONENTS.map((c) => (
              <OverviewCard key={c} component={c} messages={messages} />
            ))}
            <PmValidationCard />
          </div>
        </FadeIn>

        <FadeIn>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-sm">Fleet health matrix</CardTitle>
                <CardDescription>
                  Latest health score per vehicle &amp; component — click a cell to drill down.
                </CardDescription>
              </div>
              <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
                live pm.* stream
              </Badge>
            </CardHeader>
            <CardContent>
              {devicesLoading ? (
                <Skeleton className="h-40 w-full rounded-lg" />
              ) : devicesError ? (
                <p className="text-sm text-destructive">Error loading vehicles: {devicesError}</p>
              ) : (
                <PmHealthMatrix
                  vins={vins}
                  messages={messages}
                  selected={selected}
                  onSelect={(vin, component) => setSelected({ vin, component })}
                />
              )}
            </CardContent>
          </Card>
        </FadeIn>

        <div className="grid gap-4 xl:grid-cols-2">
          <FadeIn>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">Alert feed</CardTitle>
                  <CardDescription>Newest-first detector alerts (capped at 50).</CardDescription>
                </div>
                <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
                  {messages.length} total
                </Badge>
              </CardHeader>
              <CardContent>
                <PmAlertFeed messages={messages} />
              </CardContent>
            </Card>
          </FadeIn>

          <FadeIn>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Drill-down</CardTitle>
                <CardDescription>
                  {selected
                    ? `${selected.vin} · ${selected.component}`
                    : 'Select a cell in the matrix to see degradation trend, detector math and predicted-vs-actual.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {selected ? (
                  <PmDrillDown
                    key={`${selected.vin}|${selected.component}`}
                    vin={selected.vin}
                    component={selected.component}
                    messages={messages}
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                    No selection — click a matrix cell to drill down.
                  </div>
                )}
              </CardContent>
            </Card>
          </FadeIn>
        </div>
      </div>
    </AppLayout>
  );
}

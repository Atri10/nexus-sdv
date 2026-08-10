'use client';

import { useMemo } from 'react';
import { severityColor, type PmMessage } from '@/lib/pm-types';

export const PM_COMPONENTS = ['battery', 'brake', 'tires'] as const;
export type PmComponent = (typeof PM_COMPONENTS)[number];

/**
 * Telemetry qualifiers (Bigtable column, without the family prefix) that
 * each predictive-maintenance component is built from. /pm owns the
 * {battery, brake, tires} vocabulary — brake and tires are not first-class
 * demo components, so the drill-down filters telemetry series with this map
 * instead of the demo's component metadata (which only knows battery).
 */
export const PM_COMPONENT_SENSORS: Record<PmComponent, string[]> = {
  battery: ['battery.voltage', 'battery.current', 'battery.soc', 'battery.temp'],
  brake: ['BRAKE_PEDAL_PCT', 'VELOCITY'],
  tires: ['TIRE_PRESSURE', 'TIRE_TEMP'],
};

/** Chart series whose column qualifier (after 'family:') is a sensor of the component. */
export function pmSeriesForComponent<T extends { column: string }>(
  series: T[],
  component: PmComponent
): T[] {
  const sensors = PM_COMPONENT_SENSORS[component];
  return series.filter((s) => {
    const colon = s.column.indexOf(':');
    const q = colon > -1 ? s.column.slice(colon + 1) : s.column;
    return sensors.includes(q);
  });
}

export interface PmHealthMatrixProps {
  vins: string[];
  messages: PmMessage[];
  selected: { vin: string; component: PmComponent } | null;
  onSelect: (vin: string, component: PmComponent) => void;
}

/**
 * Fleet health matrix: rows = VINs (from /api/devices), columns = the three
 * predictive-maintenance components this page owns (battery, brake, tires).
 * Each cell shows the latest health_score for that vin+component (keyed from
 * usePmMessages, newest-first) tinted with the severity color, or '—' when no
 * message has arrived yet. Clicking a cell drills down into that pair.
 */
export function PmHealthMatrix({ vins, messages, selected, onSelect }: PmHealthMatrixProps) {
  // Latest PmMessage per vin+component (messages are already newest-first).
  const latestByPair = useMemo(() => {
    const map = new Map<string, PmMessage>();
    for (const msg of messages) {
      const key = `${msg.vin}|${msg.component}`;
      if (!map.has(key)) map.set(key, msg);
    }
    return map;
  }, [messages]);

  if (vins.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No vehicles found — start the simulator or ingest data.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/70">
            <th className="px-3 py-2 text-left font-mono text-xs font-semibold tracking-wider text-muted-foreground">
              VIN
            </th>
            {PM_COMPONENTS.map((c) => (
              <th
                key={c}
                className="px-3 py-2 text-center font-mono text-xs font-semibold tracking-wider text-muted-foreground"
              >
                {c.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vins.map((vin) => (
            <tr key={vin} className="border-b border-border/40">
              <td className="px-3 py-1.5 font-mono text-xs text-foreground/90">{vin}</td>
              {PM_COMPONENTS.map((component) => {
                const msg = latestByPair.get(`${vin}|${component}`);
                const score = msg?.health_score;
                const active =
                  selected !== null && selected.vin === vin && selected.component === component;
                return (
                  <td key={component} className="px-1.5 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => onSelect(vin, component)}
                      aria-label={`Drill down ${component} health for ${vin}`}
                      className={`inline-flex min-w-14 items-center justify-center rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition-colors ${
                        active
                          ? 'border-cyan-400 ring-2 ring-cyan-400/40'
                          : 'border-transparent hover:border-border'
                      }`}
                      style={
                        msg !== undefined
                          ? {
                              backgroundColor: `${severityColor(msg.severity)}26`,
                              color: severityColor(msg.severity),
                            }
                          : undefined
                      }
                    >
                      {score !== undefined ? score : '—'}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

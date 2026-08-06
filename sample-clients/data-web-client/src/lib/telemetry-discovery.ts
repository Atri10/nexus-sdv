import type { ComponentStatus, SignalInfo } from '@/lib/demo-control';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

/** Column qualifier without the family prefix ('dynamic:battery.voltage' → 'battery.voltage'). */
export function qualifierOf(column: string): string {
  const colon = column.indexOf(':');
  return colon > -1 ? column.slice(colon + 1) : column;
}

/** The component that owns a signal qualifier, or undefined when unknown. */
export function componentForSignal(
  components: ComponentStatus[] | null,
  qualifier: string
): ComponentStatus | undefined {
  if (!components) return undefined;
  return components.find((c) => c.sensors.some((s) => s.name === qualifier));
}

/** Sensors declared for a component id (empty when the component is unknown). */
export function signalsForComponent(components: ComponentStatus[] | null, componentId: string): SignalInfo[] {
  return components?.find((c) => c.id === componentId)?.sensors ?? [];
}

/** Unit declared for a signal qualifier, or undefined. */
export function unitForSignal(components: ComponentStatus[] | null, qualifier: string): string | undefined {
  return componentForSignal(components, qualifier)?.sensors.find((s) => s.name === qualifier)?.unit;
}

/**
 * Groups chart series by the component that owns them (key 'unassigned' for
 * signals no discovered component declares — they still render, just
 * ungrouped). Order follows the components array, then insertion.
 */
export function componentsForSeries(
  components: ComponentStatus[] | null,
  series: ChartSeries[]
): Map<string, ChartSeries[]> {
  const groups = new Map<string, ChartSeries[]>();
  for (const s of series) {
    const qualifier = qualifierOf(s.column);
    const id = componentForSignal(components, qualifier)?.id ?? 'unassigned';
    const list = groups.get(id);
    if (list) list.push(s);
    else groups.set(id, [s]);
  }
  return groups;
}

'use client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { ComponentStatus } from '@/lib/demo-control';

type ComponentPhase = 'active' | 'paused' | 'offline';

function phaseFor(component: ComponentStatus, online: boolean): ComponentPhase {
  if (!online) return 'offline';
  return component.enabled ? 'active' : 'paused';
}

const PHASE_LABEL: Record<ComponentPhase, string> = {
  active: 'Active',
  paused: 'Paused',
  offline: 'Offline',
};

const PHASE_CLASS: Record<ComponentPhase, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  offline: 'bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400',
};

export interface ComponentPanelProps {
  components: ComponentStatus[] | null;
  /** Discovered simulator VIN, or null when the simulator is unreachable. */
  simulatorVin: string | null;
  busy: boolean;
  onToggle: (componentId: string, enable: boolean) => void;
}

/**
 * Component control panel: one card per discovered component with an
 * enable/disable switch and an Active / Paused / Offline phase badge.
 * Everything (labels, sensors, units) comes from the simulator's status
 * reply — new components appear automatically.
 */
export function ComponentPanel({ components, simulatorVin, busy, onToggle }: ComponentPanelProps) {
  if (!components || components.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No components discovered — start the simulator to see component controls.
        </CardContent>
      </Card>
    );
  }
  const online = simulatorVin !== null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Components</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {components.map((component) => {
          const phase = phaseFor(component, online);
          return (
            <div
              key={component.id}
              className="flex items-start justify-between gap-2 rounded-lg border border-border/60 p-3"
              data-testid={`component-${component.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{component.label}</span>
                  <Badge variant="secondary" className={`gap-1 px-1.5 py-0 text-[10px] ${PHASE_CLASS[phase]}`}>
                    {PHASE_LABEL[phase]}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {component.sensors.map((s) => (
                    <span
                      key={s.name}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {s.name}
                      {s.unit ? ` · ${s.unit}` : ''}
                    </span>
                  ))}
                </div>
              </div>
              <Switch
                aria-label={`${component.label} component`}
                checked={component.enabled}
                disabled={busy || !online}
                onCheckedChange={(next) => onToggle(component.id, next)}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

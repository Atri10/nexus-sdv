'use client';
import { Card, CardContent } from '@/components/ui/card';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import { formatValue } from '@/lib/telemetry-chart-utils';
import { DEMO_COMPONENTS, latestValuesFor } from '@/lib/demo/vehicle-components';

interface VehicleSchematicProps {
  componentId: string;
  onSelect: (id: string) => void;
  series: ChartSeries[];
}

/** Clickable node anchors over the car silhouette (viewBox 0 0 640 240). */
const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  battery: { x: 140, y: 118 },
  powertrain: { x: 330, y: 118 },
  chassis: { x: 520, y: 118 },
  cabin: { x: 330, y: 62 },
};

function qualifierOf(column: string): string {
  const colon = column.indexOf(':');
  return colon > -1 ? column.slice(colon + 1) : column;
}

/**
 * Interactive vehicle schematic for /demo: an SVG car silhouette with four
 * clickable component nodes (battery, powertrain, chassis, cabin). The active
 * node gets a highlighted fill plus a `live-ping` pulse ring. Below the SVG,
 * sensor chips show the live value (mono) per sensor of the active component.
 */
export function VehicleSchematic({ componentId, onSelect, series }: VehicleSchematicProps) {
  const active = DEMO_COMPONENTS.find((c) => c.id === componentId) ?? DEMO_COMPONENTS[0];
  const values = latestValuesFor(series, componentId);
  const colorFor = (qualifier: string) => series.find((s) => qualifierOf(s.column) === qualifier)?.color;

  return (
    <Card>
      <CardContent className="p-4">
        <svg viewBox="0 0 640 240" className="w-full">
          {/* car silhouette — decorative */}
          <g aria-hidden="true">
            <rect x="60" y="155" width="520" height="55" rx="26" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="2" />
            <path
              d="M 195 155 L 215 100 Q 225 86 245 86 L 385 86 Q 405 86 415 100 L 440 155 Z"
              fill="#dbeafe"
              stroke="#93c5fd"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <rect x="250" y="100" width="62" height="40" rx="8" fill="#bae6fd" stroke="#7dd3fc" strokeWidth="1.5" />
            <rect x="330" y="100" width="62" height="40" rx="8" fill="#bae6fd" stroke="#7dd3fc" strokeWidth="1.5" />
            <rect x="64" y="172" width="12" height="8" rx="3" fill="#fde68a" />
            <rect x="564" y="172" width="12" height="8" rx="3" fill="#fca5a5" />
            <circle cx="170" cy="205" r="28" fill="#334155" />
            <circle cx="170" cy="205" r="10" fill="#64748b" />
            <circle cx="480" cy="205" r="28" fill="#334155" />
            <circle cx="480" cy="205" r="10" fill="#64748b" />
          </g>

          {/* clickable component nodes */}
          {DEMO_COMPONENTS.map((comp) => {
            const pos = NODE_POSITIONS[comp.id];
            const isActive = comp.id === componentId;
            return (
              <g
                key={comp.id}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-label={`${comp.label}: ${comp.description}`}
                onClick={() => onSelect(comp.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(comp.id);
                  }
                }}
                className={`cursor-pointer focus:outline-none ${isActive ? '' : 'opacity-75 hover:opacity-100'}`}
              >
                {isActive && (
                  <circle
                    className="live-ping"
                    cx={pos.x}
                    cy={pos.y}
                    r={22}
                    fill="none"
                    stroke="#3B82F6"
                    strokeWidth="2"
                    style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                  />
                )}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={17}
                  fill={isActive ? '#3B82F6' : '#ffffff'}
                  stroke={isActive ? '#1D4ED8' : '#64748b'}
                  strokeWidth="2"
                />
                <text
                  x={pos.x}
                  y={pos.y + 34}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight={isActive ? 700 : 500}
                  className="fill-muted-foreground"
                >
                  {comp.label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* live sensor chips for the active component */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {active.sensors.map((sensor) => {
            const value = values.get(sensor.qualifier);
            const color = colorFor(sensor.qualifier) ?? 'var(--muted-foreground)';
            return (
              <div key={sensor.qualifier} className="rounded-lg border bg-background p-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{sensor.label}</span>
                </div>
                <p className="mt-1 truncate font-mono text-sm font-semibold tabular-nums">
                  {value != null ? (
                    <>
                      {typeof value === 'number' ? formatValue(value) : value}
                      {sensor.unit && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{sensor.unit}</span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

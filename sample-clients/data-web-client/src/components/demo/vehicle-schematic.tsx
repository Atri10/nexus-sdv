'use client';
import { Card, CardContent } from '@/components/ui/card';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import { formatValue } from '@/lib/telemetry-chart-utils';
import type { ComponentStatus } from '@/lib/demo-control';

interface VehicleSchematicProps {
  componentId: string;
  onSelect: (id: string) => void;
  series: ChartSeries[];
  /** Discovered components from the simulator status reply. */
  components: ComponentStatus[] | null;
}

/** Clickable node anchors over the car silhouette (viewBox 0 0 640 240). */
const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  battery: { x: 140, y: 118 },
  powertrain: { x: 330, y: 118 },
  chassis: { x: 520, y: 118 },
  cabin: { x: 330, y: 62 },
};

/** Fallback anchor for undiscovered components, spread along the body. */
function fallbackNodePosition(index: number): { x: number; y: number } {
  return { x: 140 + (index * (520 - 140)) / Math.max(1, 5 - 1), y: 118 };
}

function qualifierOf(column: string): string {
  const colon = column.indexOf(':');
  return colon > -1 ? column.slice(colon + 1) : column;
}

function latestValueFor(series: ChartSeries[], qualifier: string): number | string | null {
  const s = series.find((c) => qualifierOf(c.column) === qualifier);
  if (!s) return null;
  for (let i = s.points.length - 1; i >= 0; i--) {
    const p = s.points[i];
    if (p.y != null) return p.y;
    if (p.raw != null) return String(p.raw);
  }
  return null;
}

/**
 * Interactive vehicle schematic for /demo: an SVG car silhouette with one
 * clickable node per discovered component. The active node gets a highlighted
 * fill plus a `live-ping` pulse ring. Below the SVG, sensor chips show the
 * live value (mono) per sensor of the active component. Component labels,
 * sensors and units all come from the discovery prop — nothing hardcoded.
 */
export function VehicleSchematic({ componentId, onSelect, series, components }: VehicleSchematicProps) {
  const discovered = components ?? [];
  const active = discovered.find((c) => c.id === componentId) ?? null;
  const nodes = discovered.map((comp, i) => ({
    comp,
    pos: NODE_POSITIONS[comp.id] ?? fallbackNodePosition(i),
  }));
  const colorFor = (qualifier: string) => series.find((s) => qualifierOf(s.column) === qualifier)?.color;

  return (
    <Card>
      <CardContent className="p-4">
        <svg viewBox="0 0 640 240" className="w-full">
          {/* car silhouette — decorative (side view, front at left) */}
          <g aria-hidden="true">
            <defs>
              <linearGradient id="car-body" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#eef2f7" />
                <stop offset="100%" stopColor="#c3ccd8" />
              </linearGradient>
              <linearGradient id="car-glass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8b9ab0" />
                <stop offset="100%" stopColor="#52617a" />
              </linearGradient>
            </defs>

            {/* ground shadow */}
            <ellipse cx="325" cy="232" rx="250" ry="7" fill="#94a3b8" opacity="0.35" />

            {/* body: bumper -> hood -> windshield base -> beltline -> trunk -> rear bumper,
                with wheel arches cut into the rocker */}
            <path
              d="M 100 196 L 100 160 C 100 152 106 146 116 143 C 150 137 190 134 240 134 C 258 134 268 118 302 66 L 398 66 C 434 66 448 100 458 136 C 480 140 520 142 546 146 C 556 148 560 154 560 162 L 560 196 L 512 196 Q 480 150 448 196 L 202 196 Q 170 150 138 196 L 100 196 Z"
              fill="url(#car-body)"
              stroke="#64748b"
              strokeWidth="2"
              strokeLinejoin="round"
            />

            {/* glasshouse: windshield, roof, rear glass */}
            <path
              d="M 252 132 C 264 122 278 100 302 72 L 398 72 C 428 76 440 106 450 132 L 258 133 Z"
              fill="url(#car-glass)"
              stroke="#52617a"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            {/* B-pillar */}
            <line x1="330" y1="73" x2="330" y2="133" stroke="#0f172a" strokeOpacity="0.35" strokeWidth="2" />

            {/* wheel wells */}
            <circle cx="170" cy="205" r="30" fill="#1e293b" opacity="0.25" />
            <circle cx="480" cy="205" r="30" fill="#1e293b" opacity="0.25" />

            {/* wheels */}
            <circle cx="170" cy="205" r="28" fill="#1f2937" />
            <circle cx="170" cy="205" r="17" fill="none" stroke="#64748b" strokeWidth="3" />
            <circle cx="170" cy="205" r="6.5" fill="#94a3b8" />
            <circle cx="480" cy="205" r="28" fill="#1f2937" />
            <circle cx="480" cy="205" r="17" fill="none" stroke="#64748b" strokeWidth="3" />
            <circle cx="480" cy="205" r="6.5" fill="#94a3b8" />

            {/* side mirror */}
            <rect x="238" y="118" width="9" height="13" rx="3" fill="#64748b" />

            {/* door handle + fuel cap */}
            <rect x="352" y="150" width="20" height="4.5" rx="2.25" fill="#94a3b8" />
            <circle cx="505" cy="148" r="4" fill="#94a3b8" />

            {/* headlight + taillight */}
            <rect x="103" y="166" width="14" height="8" rx="3" fill="#fde68a" />
            <rect x="547" y="157" width="12" height="7" rx="3" fill="#fca5a5" />
          </g>

          {/* clickable component nodes */}
          {nodes.map(({ comp, pos }) => {
            const isActive = comp.id === componentId;
            return (
              <g
                key={comp.id}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-label={`${comp.label} component`}
                onClick={() => onSelect(comp.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(comp.id);
                  }
                }}
                className={`cursor-pointer ${isActive ? '' : 'opacity-75 hover:opacity-100'}`}
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
          {(active?.sensors ?? []).map((sensor) => {
            const value = latestValueFor(series, sensor.name);
            const color = colorFor(sensor.name) ?? 'var(--muted-foreground)';
            return (
              <div key={sensor.name} className="rounded-lg border bg-background p-2">
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

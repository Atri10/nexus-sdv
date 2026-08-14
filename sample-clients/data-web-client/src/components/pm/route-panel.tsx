'use client';

import { useMemo } from 'react';
import { DEMO_ROUTE_POINTS } from '@/lib/pm-route';

interface RoutePanelProps {
  /** Fractional progress through the current lap (0..1). */
  progress: number;
  /** Current lap number (0-based). */
  lap: number;
  /** Total loop length in metres. */
  totalM: number;
  /** Demo-speed multiplier (1 = real-time). */
  speed: number;
}

const PAD = 24;

/**
 * Normalize the route's GPS points into SVG viewport coordinates, once per
 * route (memoized — never recomputed per telemetry tick). Lat/lng are
 * projected with an equirectangular fit: x = lng, y = -lat scaled to the
 * bounding box, preserving the route's shape.
 */
function projectRoute(): { d: string; markerAt: (f: number) => [number, number]; W: number; H: number } {
  const lats = DEMO_ROUTE_POINTS.map((p) => p[0]);
  const lngs = DEMO_ROUTE_POINTS.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = Math.max(maxLat - minLat, 1e-9);
  const spanLng = Math.max(maxLng - minLng, 1e-9);
  const scale = Math.min(900 / spanLng, 460 / spanLat);

  const toXY = (lat: number, lng: number): [number, number] => [
    PAD + (lng - minLng) * scale,
    PAD + (maxLat - lat) * scale,
  ];
  const pts = DEMO_ROUTE_POINTS.map(([lat, lng]) => toXY(lat, lng));

  const d = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const W = spanLng * scale + 2 * PAD;
  const H = spanLat * scale + 2 * PAD;

  // Cumulative polyline length for progress-based marker interpolation.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];

  const markerAt = (f: number): [number, number] => {
    const target = (f - Math.floor(f)) * total;
    let i = 1;
    while (i < pts.length && cum[i] < target) i++;
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = (target - cum[i - 1]) / segLen;
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  };

  return { d, markerAt, W, H };
}

/**
 * Route panel: the simulator's predefined Bangalore loop rendered as an SVG
 * polyline, with an animated vehicle marker at the current progress and a
 * prominent lap counter. The route is the visual anchor of the PM story —
 * same vehicle, same route, repeated laps, accumulating degradation.
 */
export function RoutePanel({ progress, lap, totalM, speed }: RoutePanelProps) {
  const { d, markerAt, W, H } = useMemo(projectRoute, []);
  const [mx, my] = useMemo(() => markerAt(progress), [markerAt, progress]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <svg
        viewBox={`0 0 ${W.toFixed(0)} ${H.toFixed(0)}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Vehicle position on the demo route, lap ${lap + 1}`}
      >
        {/* Route polyline */}
        <path
          d={d}
          fill="none"
          stroke="rgba(148, 163, 184, 0.5)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Vehicle marker */}
        <circle cx={mx} cy={my} r={7} fill="#3B82F6" stroke="#0F172A" strokeWidth={2} />
        <circle
          cx={mx}
          cy={my}
          r={12}
          fill="none"
          stroke="#3B82F6"
          strokeOpacity={0.35}
          strokeWidth={1.5}
        />
      </svg>

      {/* Lap overlay */}
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-md border border-border/70 bg-background/90 px-2.5 py-1.5 backdrop-blur">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Lap
        </span>
        <span className="font-mono text-lg font-bold leading-none text-foreground">
          {String(lap + 1).padStart(2, '0')}
        </span>
      </div>

      {/* Progress bar + speed */}
      <div className="pointer-events-none absolute inset-x-3 bottom-2.5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full bg-blue-500 transition-[width] duration-500 ease-linear"
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {Math.round(progress * 100)}%
          </span>
          <span className="font-mono text-[10px] tabular-nums text-blue-400">
            {totalM > 0 ? `${(totalM / 1000).toFixed(1)} km` : '—'}
          </span>
          {speed > 1 && (
            <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-500">
              ⚡ {speed}×
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { gpsTrail, latestGps } from '@/lib/gps-trail';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export interface VehicleMapProps {
  series: ChartSeries[];
  /** Chassis component disabled — the trail froze; show the overlay. */
  paused: boolean;
}

const TRAIL_COLOR = '#22d3ee';
const LABEL_COLOR = 'rgba(148, 163, 184, 0.7)';
const GRID_COLOR = 'rgba(148, 163, 184, 0.15)';

interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

function boundsFor(trail: { lat: number; lng: number }[]): Bounds {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of trail) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  let latSpan = maxLat - minLat;
  let lngSpan = maxLng - minLng;
  if (latSpan === 0) latSpan = 0.0008;
  if (lngSpan === 0) lngSpan = 0.0008;
  const latPad = latSpan * 0.12;
  const lngPad = lngSpan * 0.12;
  return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLng: minLng - lngPad, maxLng: maxLng + lngPad };
}

/**
 * Live GPS track map for /demo: a self-contained 2D canvas (no tile/map
 * dependencies — offline-safe) plotting the lat/lng trail from the
 * discovered GPS telemetry series, with a graticule, a start marker and a
 * pulsing current-position marker. When the chassis component is paused the
 * trail stops growing and the panel shows the pause overlay.
 */
export function VehicleMap({ series, paused }: VehicleMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const live = !paused && !reducedMotion;

  const trail = useMemo(() => gpsTrail(series), [series]);
  const latest = useMemo(() => latestGps(series), [series]);
  const [sizeToken, setSizeToken] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / WebGL-less environments: nothing to draw

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 600;
    const height = rect.height || canvas.clientHeight || 288;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = (ringRadius: number, ringAlpha: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.6)';
      ctx.fillRect(0, 0, width, height);

      if (trail.length === 0) return;
      const b = boundsFor(trail);
      const toX = (lng: number) => ((lng - b.minLng) / (b.maxLng - b.minLng)) * width;
      const toY = (lat: number) => height - ((lat - b.minLat) / (b.maxLat - b.minLat)) * height;

      // graticule (5x5) with lat/lng labels
      ctx.font = '10px ui-monospace, monospace';
      ctx.strokeStyle = GRID_COLOR;
      ctx.fillStyle = LABEL_COLOR;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const fx = i / 5;
        const lng = b.minLng + fx * (b.maxLng - b.minLng);
        const lat = b.minLat + fx * (b.maxLat - b.minLat);
        ctx.beginPath();
        ctx.moveTo(fx * width, 0);
        ctx.lineTo(fx * width, height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, fx * height);
        ctx.lineTo(width, fx * height);
        ctx.stroke();
        ctx.fillText(lng.toFixed(5), fx * width + 3, 12);
        ctx.fillText(lat.toFixed(5), 3, height - fx * height - 4);
      }

      // trail
      if (trail.length > 1) {
        ctx.strokeStyle = TRAIL_COLOR;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.shadowColor = TRAIL_COLOR;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        trail.forEach((p, i) => {
          const x = toX(p.lng);
          const y = toY(p.lat);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // start marker
      const first = trail[0];
      const sx = toX(first.lng);
      const sy = toY(first.lat);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillRect(sx - 3, sy - 3, 6, 6);

      // current fix: crosshair + dot + optional pulse ring
      const last = trail[trail.length - 1];
      const cx = toX(last.lng);
      const cy = toY(last.lat);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.moveTo(0, cy);
      ctx.lineTo(width, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ringRadius > 0) {
        ctx.strokeStyle = `rgba(34, 211, 238, ${ringAlpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = TRAIL_COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    };

    if (!live) {
      draw(0, 0);
      return;
    }

    // Paint the static scene synchronously — rAF is throttled in hidden or
    // headless tabs, so the trail must not wait for the first animation frame.
    draw(0, 0);

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      draw(8 + 8 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)), 0.6 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [trail, live, sizeToken]);

  // Re-run the draw effect when the panel resizes (ResizeObserver is
  // undefined in jsdom — guard so tests keep passing).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSizeToken((t) => t + 1));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="font-display text-sm font-bold tracking-[0.3em] text-cyan-700 glow-text dark:text-cyan-400">
          LIVE GPS TRACK
        </CardTitle>
        <div className="flex items-center gap-2">
          {live && <span className="relative flex h-2 w-2" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>}
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {latest ? `lat ${latest.lat.toFixed(5)}° · lng ${latest.lng.toFixed(5)}°` : '—'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="relative">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Live GPS track map"
          className="h-72 w-full rounded-lg"
        />
        {trail.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-muted-foreground">Waiting for GPS signal…</span>
          </div>
        )}
        {paused && (
          <div className="absolute inset-0 flex items-center justify-center rounded bg-background/60 backdrop-blur-[1px]">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              Paused — track retained
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DemoControlReply } from '@/lib/demo-control';

const POLL_MS = 3000;

export interface SimulatorState {
  /** Discovered simulator VIN (null = no simulator reachable). */
  vin: string | null;
  running: boolean;
  /** Full last status reply (route/live/ground_truth/speed). */
  sim: DemoControlReply | null;
  lastUpdated: number | null;
}

/**
 * Single source of truth for simulator state across ALL pages (/pm, /demo,
 * /fleet, /device). One poll loop discovers the sim VIN and fetches status;
 * every page consumes the same state, so pages can never disagree about
 * whether the simulator is running (previously each page polled with its own
 * timers and one-shot discovers — the cross-page inconsistency bugs).
 */
export function useSimulatorState() {
  const [state, setState] = useState<SimulatorState>({
    vin: null,
    running: false,
    sim: null,
    lastUpdated: null,
  });
  const vinRef = useRef<string | null>(null);
  const consecutiveFailures = useRef(0);
  // Monotonic counter bumped by every user command. A poll reply that was
  // dispatched BEFORE the command but resolves AFTER it must not overwrite
  // the command's fresh state (last-writer-wins race).
  const commandEpoch = useRef(0);

  const fetchStatus = useCallback(async (vin: string): Promise<DemoControlReply | null> => {
    try {
      const res = await fetch('/api/demo/vehicle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', vin }),
      });
      if (!res.ok) return null;
      const reply = (await res.json()) as DemoControlReply;
      return reply && !reply.error ? reply : null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    // Discover only when we don't know the VIN or it went silent (the sim
    // re-randomizes its VIN on container restarts).
    let vin = vinRef.current;
    if (!vin) {
      try {
        const r = await fetch('/api/demo/discover', { cache: 'no-store' });
        const d = (await r.json()) as { vin?: string | null };
        if (d?.vin) {
          vin = d.vin;
          vinRef.current = vin;
        }
      } catch {
        /* no simulator — keep vin null */
      }
    }
    if (!vin) {
      setState({ vin: null, running: false, sim: null, lastUpdated: null });
      return;
    }
    // Snapshot the epoch BEFORE the fetch: a command issued while this poll
    // is in flight bumps the epoch, and this stale reply must not overwrite
    // the command's fresh state (last-writer-wins race).
    const epochAtFetch = commandEpoch.current;
    const reply = await fetchStatus(vin);
    if (reply && epochAtFetch === commandEpoch.current) {
      // Healthy reply — reset the failure counter.
      consecutiveFailures.current = 0;
      setState({ vin, running: reply.running, sim: reply, lastUpdated: Date.now() });
    } else {
      // One dropped poll is a blip (NATS hiccup, 503); only after two
      // consecutive failures do we treat the sim as gone and clear, so the
      // next poll re-discovers (the sim re-randomizes its VIN on restarts).
      // Without this hysteresis a single transient error would tear the UI
      // down mid-session.
      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= 2) {
        vinRef.current = null;
        setState({ vin: null, running: false, sim: null, lastUpdated: null });
      }
    }
  }, [fetchStatus]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  /** Single write path for start/stop/speed/reset — targets the sim VIN. */
  const command = useCallback(
    async (
      action: 'start' | 'stop' | 'speed' | 'reset',
      preset?: string,
      component?: string
    ): Promise<DemoControlReply | null> => {
      const vin = vinRef.current;
      if (!vin) return null;
      // Invalidate any in-flight poll reply older than this command.
      commandEpoch.current += 1;
      try {
        const body: Record<string, string> = { action, vin };
        if (preset) body.preset = preset;
        if (component) body.component = component;
        const res = await fetch('/api/demo/vehicle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const reply = (await res.json()) as DemoControlReply;
        if (reply && !reply.error) {
          setState({ vin, running: reply.running, sim: reply, lastUpdated: Date.now() });
        }
        return reply;
      } catch {
        return null;
      }
    },
    []
  );

  return { ...state, refresh, command };
}

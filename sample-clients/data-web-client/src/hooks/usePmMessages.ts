'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePmMessage, type PmMessage } from '@/lib/pm-types';

const STORAGE_KEY = 'pmMessages';
const STORAGE_GEN_KEY = 'pmMessages.gen';
// One hundred messages shared across all VINs can evict a selected VIN's
// alerts (the detector publishes every poll for every scheduled VIN). 250
// keeps a 10-VIN demo's recent alerts visible while staying small.
const MAX_MESSAGES = 250;

/** Identity of a PM message for dedup: the detector publishes continuously
 * in demo mode and EventSource auto-reconnects, so the same (vin, component,
 * timestamp) can arrive twice after a blip. Treat those as duplicates. */
function messageId(m: PmMessage): string {
  return `${m.vin}|${m.component}|${m.timestamp}`;
}

/**
 * Subscribe to the predictive-maintenance SSE stream and persist incoming
 * messages to sessionStorage so they survive page reloads within the same
 * tab session.
 *
 * On mount the hook hydrates state from sessionStorage (if any), then opens
 * the EventSource. Every new message is prepended to the in-memory list AND
 * written back to sessionStorage in the same update, keeping the two in sync.
 */
export function usePmMessages() {
  // Hydrate from sessionStorage via a lazy initializer: sessionStorage
  // doesn't exist on the server, so the SSR render gets [] and the client
  // first render hydrates from storage — no setState-in-effect needed.
  // (react-hooks/set-state-in-effect — the old hydration effect failed CI.)
  const [messages, setMessages] = useState<PmMessage[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Trim on hydration too — protects against legacy entries that
      // pre-date the cap, or a manual edit of sessionStorage.
      //
      // Entries stored by the message effect are PmMessage OBJECTS
      // (JSON.stringify of the parsed message), unlike useScoringMessages
      // which stores raw strings. Accept both forms; parsePmMessage wraps
      // JSON.parse in try/catch, so corrupted entries map to null and are
      // filtered out below.
      const seen = new Set<string>();
      return parsed
        .map((m) => (typeof m === 'string' ? parsePmMessage(m) : parsePmMessage(JSON.stringify(m))))
        .filter((m): m is PmMessage => {
          if (m === null) return false;
          const id = messageId(m);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, MAX_MESSAGES);
    } catch {
      // Corrupted entry — ignore and start fresh.
      return [];
    }
  });
  // Generation snapshot at mount: if another page clears alerts while this
  // page is mounted, the generation moves and this page's writes are stale —
  // skip the setItem so cleared alerts aren't resurrected.
  const genRef = useRef<string | null>(null);

  // Snapshot the generation once, client-side (storage is not readable
  // during SSR). The ref is deliberately populated here, not in state.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      genRef.current = window.sessionStorage.getItem(STORAGE_GEN_KEY);
    }
  }, []);

  // Open the SSE stream once on mount. Each message is parsed (invalid
  // payloads are skipped), prepended to state and the same updated list is
  // written to sessionStorage so a reload restores exactly what was on screen.
  useEffect(() => {
    const source = new EventSource('/api/pm/stream');
    source.onmessage = (e) => {
      const message = parsePmMessage(e.data);
      if (message === null) return;
      setMessages((prev) => {
        // Dedup on identity: the detector publishes every poll in demo mode
        // and EventSource auto-reconnects, so the same (vin, component,
        // timestamp) can arrive twice after a blip — don't stack duplicates.
        if (prev.length > 0 && messageId(prev[0]) === messageId(message)) {
          return prev;
        }
        // Newest message goes to index 0; cap the total at MAX_MESSAGES so
        // the array (and sessionStorage payload) can't grow unboundedly.
        // If a clear happened on another page after we mounted, our in-memory
        // list predates it. Drop the stale list entirely (start fresh from
        // this message) instead of merely skipping one write — otherwise the
        // next message would resurrect the pre-clear alerts. Note: we can't
        // distinguish 'no generation stored yet' from 'generation matches',
        // so treat a missing gen as matching (first-mount write).
        const currentGen = window.sessionStorage.getItem(STORAGE_GEN_KEY);
        if (genRef.current !== null && currentGen !== genRef.current) {
          genRef.current = currentGen;
          const fresh = [message].slice(0, MAX_MESSAGES);
          try {
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
          } catch {
            /* storage disabled — in-memory list is still correct */
          }
          return fresh;
        }
        genRef.current = currentGen;
        const next = [message, ...prev].slice(0, MAX_MESSAGES);
        try {
          window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Quota exceeded or storage disabled — fall through; the in-memory
          // list still updates so the UI stays correct for this session.
        }
        return next;
      });
    };
    // Do NOT close on error: EventSource auto-reconnects after network
    // blips and transient 5xx responses, which is exactly what we want
    // (the stream recovers when NATS/the route come back). Closing here
    // would permanently kill the panel on a single blip. The browser gives
    // up on its own after repeated failures.
    source.onerror = () => {};
    return () => source.close();
  }, []);

  // Clear the accumulated alert list — demo reset hygiene. Drops the
  // in-memory state and the sessionStorage copy atomically so a reload
  // after "clear alerts" starts empty instead of resurrecting stale
  // alerts. The SSE stream keeps running: new alerts append as they
  // arrive (the detector publishes on severity change, so a cleared
  // list stays empty until a component actually re-crosses a band).
  const clearAlerts = useCallback(() => {
    setMessages([]);
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
      // Bump the generation so another page's stale in-memory list (mounted
      // before this clear) can detect its writes are obsolete and skip the
      // setItem that would resurrect the cleared alerts.
      window.sessionStorage.setItem(STORAGE_GEN_KEY, String(Date.now()));
    } catch {
      // Storage disabled — in-memory clear above is enough.
    }
  }, []);

  return { messages, clearAlerts };
}

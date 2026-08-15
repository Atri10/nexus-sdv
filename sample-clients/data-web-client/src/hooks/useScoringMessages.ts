'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'scoringMessages';
const MAX_MESSAGES = 100;

/**
 * Subscribe to the scoring SSE stream and persist incoming messages to
 * sessionStorage so they survive page reloads within the same tab session.
 *
 * On mount the hook hydrates state from sessionStorage (if any), then opens
 * the EventSource. Every new message is prepended to the in-memory list AND
 * written back to sessionStorage in the same update, keeping the two in sync.
 */
export function useScoringMessages() {
  // Hydrate from sessionStorage via a lazy initializer (SSR-safe: storage
  // doesn't exist on the server, so the SSR render gets [] and the client
  // first render hydrates). No setState-in-effect — react-hooks lint.
  const [messages, setMessages] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Trim on hydration too — protects against legacy entries that
      // pre-date the cap, or a manual edit of sessionStorage.
      return parsed.filter((m): m is string => typeof m === 'string').slice(0, MAX_MESSAGES);
    } catch {
      // Corrupted entry — ignore and start fresh.
      return [];
    }
  });

  // Open the SSE stream once on mount. Each message is prepended to state
  // and the same updated list is written to sessionStorage so a reload
  // restores exactly what was on screen.
  useEffect(() => {
    const source = new EventSource('/api/scoring/stream');
    source.onmessage = (e) => {
      setMessages((prev) => {
        // Dedup on identity: EventSource auto-reconnects and the stream
        // replays recent messages, so the same payload can arrive twice —
        // don't stack duplicates of the newest entry.
        if (prev.length > 0 && prev[0] === e.data) return prev;
        // Newest message goes to index 0; cap the total at MAX_MESSAGES so
        // the array (and sessionStorage payload) can't grow unboundedly.
        const next = [e.data, ...prev].slice(0, MAX_MESSAGES);
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
    // would permanently kill the panel on a single blip.
    source.onerror = () => {};
    return () => source.close();
  }, []);

  return messages;
}

'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { severityColor, type PmMessage } from '@/lib/pm-types';

export interface PmAlertFeedProps {
  messages: PmMessage[];
}

const FEED_LIMIT = 50;
const PAGE_SIZE = 20;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Newest-first predictive-maintenance alert feed (usePmMessages already
 * prepends newest messages). Each row: severity badge tinted with the real
 * severity color, `vin · component · timestamp`, the explanation, and a
 * <details> block with the raw evidence JSON. Capped at 50 messages with a
 * "Show more" pager for older entries.
 */
export function PmAlertFeed({ messages }: PmAlertFeedProps) {
  const [visibleCount, setVisibleCount] = useState(FEED_LIMIT);
  const capped = useMemo(() => messages.slice(0, FEED_LIMIT), [messages]);
  const visible = capped.slice(0, visibleCount);
  const hasMore = visibleCount < capped.length;

  if (capped.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No predictive-maintenance alerts yet — the detector publishes on the pm.* stream once it
        has enough telemetry per vehicle.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {visible.map((m, i) => (
          <li
            key={`${m.timestamp}-${m.vin}-${m.component}-${i}`}
            className="rounded-lg border border-border/60 bg-card/50 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                className="font-mono text-[10px] uppercase tracking-wider"
                style={{ backgroundColor: `${severityColor(m.severity)}26`, color: severityColor(m.severity) }}
              >
                {m.severity}
              </Badge>
              <span className="font-mono text-xs text-foreground/90">
                {m.vin} · {m.component} · {formatTimestamp(m.timestamp)}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-foreground/85">{m.explanation}</p>
            <details className="mt-1.5">
              <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground">
                evidence
              </summary>
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(m.evidence, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ul>
      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount(visibleCount + PAGE_SIZE)}>
            Show more ({capped.length - visibleCount} remaining)
          </Button>
        </div>
      )}
    </div>
  );
}

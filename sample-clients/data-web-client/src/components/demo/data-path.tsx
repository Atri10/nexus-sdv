'use client';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';

const STAGES = ['Component', 'NATS', 'Connector', 'Bigtable', 'Chart service', 'Graph'] as const;

const NODE_X = (i: number) => 30 + i * 150;
const NODE_Y = 60;

/**
 * Animated pipeline for /demo: Component → NATS → Connector → Bigtable →
 * Chart service → Graph. While `flowing` the connecting polyline gets the
 * `flow-dash` class (animated dashes, disabled under prefers-reduced-motion)
 * and a pulse ring sweeps the currently-active stage. The SVG is decorative
 * (aria-hidden); the caption below carries the accessible description.
 */
export function DataPath({ flowing }: { flowing: boolean }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!flowing) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STAGES.length), 800);
    return () => clearInterval(id);
  }, [flowing]);

  const points = STAGES.map((_, i) => `${NODE_X(i)},${NODE_Y}`).join(' ');

  return (
    <Card>
      <CardContent className="p-4">
        <svg viewBox="0 0 840 120" className="w-full" aria-hidden="true">
          <polyline
            points={points}
            fill="none"
            stroke={flowing ? '#10B981' : '#94a3b8'}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={flowing ? 'flow-dash' : undefined}
          />
          {STAGES.map((label, i) => {
            const reached = i <= active;
            const isActive = flowing && i === active;
            return (
              <g key={label}>
                <circle
                  cx={NODE_X(i)}
                  cy={NODE_Y}
                  r={13}
                  fill={flowing && reached ? '#10B981' : '#f1f5f9'}
                  stroke="#10B981"
                  strokeWidth="2"
                />
                {isActive && (
                  <circle
                    className="live-ping"
                    cx={NODE_X(i)}
                    cy={NODE_Y}
                    r={18}
                    fill="none"
                    stroke="#10B981"
                    strokeWidth="2"
                    style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                  />
                )}
                <text
                  x={NODE_X(i)}
                  y={NODE_Y + 34}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight={flowing && reached ? 600 : 400}
                  className="fill-muted-foreground"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="mt-2 text-sm text-muted-foreground">
          {flowing
            ? 'Telemetry flowing: VIN → NATS → Connector → Bigtable → Chart service → Graph'
            : 'Pipeline idle — start the simulator to see data flow'}
        </p>
      </CardContent>
    </Card>
  );
}

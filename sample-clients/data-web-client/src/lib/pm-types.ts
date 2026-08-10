export interface PmMessage {
  vin: string;
  component: 'battery' | 'brake' | 'tires';
  health_score: number;
  severity: 'healthy' | 'advisory' | 'action' | 'critical';
  evidence: Record<string, string>;
  explanation: string;
  timestamp: string;
}

const SEVERITIES = ['healthy', 'advisory', 'action', 'critical'];
const COMPONENTS = ['battery', 'brake', 'tires'];

export function parsePmMessage(raw: string): PmMessage | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    // The SSE route emits protobufjs toJSON() output, which camelCases
    // proto fields (healthScore). Accept both key forms so messages from
    // the stream and from tests/sessionStorage parse identically.
    const healthScore = o['health_score'] ?? o['healthScore'];
    if (typeof o.vin !== 'string' || !COMPONENTS.includes(o.component as string) ||
        typeof healthScore !== 'number' || !SEVERITIES.includes(o.severity as string) ||
        typeof o.explanation !== 'string' || typeof o.timestamp !== 'string') {
      return null;
    }
    return { ...o, health_score: healthScore } as unknown as PmMessage;
  } catch {
    return null;
  }
}

/**
 * Map a PM severity to a real CSS color. Consumed as an SVG stroke / fill
 * and an inline `style.color` on /demo (gauges, alert chips, ticker), so
 * these must be actual colors — not Tailwind class names — or nothing
 * renders. The hex values match the Tailwind-600/500 palette in the
 * comments below.
 */
export function severityColor(sev: string): string {
  switch (sev) {
    case 'critical': return '#DC2626'; // red-600
    case 'action': return '#F97316';   // orange-500
    case 'advisory': return '#F59E0B'; // amber-500
    default: return '#22C55E';         // green-500
  }
}

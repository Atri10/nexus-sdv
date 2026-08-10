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

export function severityColor(sev: string): string {
  switch (sev) {
    case 'critical': return 'red-600';    // #DC2626
    case 'action': return 'orange-500';   // #F97316
    case 'advisory': return 'amber-500';  // #F59E0B
    default: return 'green-500';          // #22C55E
  }
}

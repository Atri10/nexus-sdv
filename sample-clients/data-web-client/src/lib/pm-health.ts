import type { PmMessage } from '@/lib/pm-types';

/**
 * Coherent PM health for one component.
 *
 * The detector (predictive-maintenance) publishes pm.{VIN}.{component}
 * messages, but only on its poll cycle (60s) and only for scheduled VINs.
 * Until the first message arrives, the live simulator values already show
 * the truth (a battery at 11.0 V is dying whether or not the detector has
 * published). This model merges the two sources so badges, KPIs and charts
 * can never disagree:
 *
 *   - PM message present  -> use its health_score + severity (authoritative)
 *   - A terminal battery ground-truth label -> force 0 health even if the
 *     detector's last 60-second message is stale
 *   - No PM message yet   -> derive a provisional score/severity from the
 *     live values (mirroring the detector's thresholds)
 */
export interface CoherentHealth {
  /** 0-100 health score (higher = healthier). */
  score: number;
  severity: 'healthy' | 'advisory' | 'action' | 'critical';
  /** True when derived from live values (no PM message yet). */
  provisional: boolean;
  /** Human-readable reason (from the PM message, or a live-derived one). */
  reason: string;
}

/** Wheel/pad instances the detector models per component. */
export const WHEELS = ['FL', 'FR', 'RL', 'RR'] as const;
export type Wheel = (typeof WHEELS)[number];

export interface DeathCause {
  component: 'battery' | 'tires' | 'unknown';
  wheel?: Wheel;
  pressureBar?: number;
}

/**
 * Reconstruct the simulator's end-of-life cause from the status payload.
 * This is a compatibility fallback for older simulator builds that expose
 * only `dead`, not `dead_component` and `dead_wheel`.
 */
export function deriveDeathCause(
  groundTruth: Record<string, Record<string, unknown>> | undefined
): DeathCause {
  const tires = (groundTruth?.tires ?? {}) as Record<string, Record<string, unknown>>;
  for (const wheel of WHEELS) {
    const values = tires[wheel];
    const pressure = values && Number(values.pressure_bar);
    if (Number.isFinite(pressure) && pressure <= 1.2) {
      return { component: 'tires', wheel, pressureBar: pressure };
    }
  }

  const battery = (groundTruth?.battery ?? {}) as Record<string, unknown>;
  const daysToFailure = Number(battery.days_to_failure);
  const wearFraction = Number(battery.wear_fraction);
  if (daysToFailure === 0 || (Number.isFinite(wearFraction) && wearFraction >= 1)) {
    return { component: 'battery' };
  }

  return { component: 'unknown' };
}

/**
 * Parse a PM NATS subject into its identity parts. Tires/brake subjects are
 * pm.{VIN}.{component}.{wheel} (4 tokens); battery stays pm.{VIN}.{component}
 * (3 tokens) and yields no wheel. Unknown subjects return null.
 */
export function pmMessageFromSubject(subject: string): {
  vin: string;
  component: 'battery' | 'brake' | 'tires';
  wheel?: string;
} | null {
  const parts = subject.split('.');
  if (parts.length < 3 || parts[0] !== 'pm') return null;
  const [, vin, component] = parts;
  if (!vin || !['battery', 'brake', 'tires'].includes(component)) return null;
  const wheel = parts.length >= 4 ? parts[3] : undefined;
  return { vin, component: component as 'battery' | 'brake' | 'tires', wheel };
}

/** Pick the worst (lowest health score) entry; empty input -> null. */
export function worstWheel<T extends { health_score: number }>(entries: readonly T[]): T | null {
  let worst: T | null = null;
  for (const e of entries) {
    if (worst === null || e.health_score < worst.health_score) worst = e;
  }
  return worst;
}

/**
 * Drop all PM-derived UI state for a past VIN when the simulator adopts a new
 * one: the in-memory message list, the per-component health map, and the
 * chart sample buffers. Callers pass their state setters; each is reset to
 * its empty value so the next render shows only the new VIN's data.
 *
 * `setHealth` is optional: pages that derive their health map from the
 * message list (cleared via `setMessages`) have no independent health state
 * to reset.
 */
export function clearPmState<T>(state: {
  setMessages: (messages: PmMessage[]) => void;
  setSamples: (samples: T[]) => void;
  setHealth?: (health: Record<string, CoherentHealth>) => void;
}): void {
  state.setMessages([]);
  state.setSamples([]);
  state.setHealth?.({});
}

/** Battery: 12.63 V healthy -> ~10.5 V dead. Mirrors detectors.py. */
function batteryFromVoltage(v: number | null): CoherentHealth {
  if (v === null || !Number.isFinite(v)) {
    return { score: 100, severity: 'healthy', provisional: true, reason: 'waiting for voltage data' };
  }
  // Linear map 12.63 V (100) -> 10.5 V (0), clamped.
  const score = Math.round(Math.max(0, Math.min(100, ((v - 10.5) / (12.63 - 10.5)) * 100)));
  const severity = v >= 12.4 ? 'healthy' : v >= 11.8 ? 'advisory' : 'action';
  const label =
    severity === 'healthy'
      ? `voltage ${v.toFixed(2)} V is healthy`
      : severity === 'advisory'
        ? `voltage ${v.toFixed(2)} V is low (below 12.4 V)`
        : `voltage ${v.toFixed(2)} V is critically low`;
  return { score, severity: severity === 'action' ? 'critical' : severity, provisional: true, reason: label };
}

/** Battery ground truth is SoH loss, not a voltage reading. */
function batteryFromWear(wearFrac: number): CoherentHealth {
  const wear = Math.max(0, Math.min(1, wearFrac));
  const score = Math.round((1 - wear) * 100);
  const severity = wear >= 1 ? 'critical' : wear >= 0.85 ? 'action' : wear >= 0.6 ? 'advisory' : 'healthy';
  return {
    score,
    severity,
    provisional: wear < 1,
    reason:
      wear >= 1
        ? 'ground truth: battery wear is 100%; battery health is 0%'
        : `ground truth: battery wear is ${Math.round(wear * 100)}%`,
  };
}

/** Tires: 2.3 bar healthy -> ~1.0 bar flat. Mirrors detectors.py. */
function tiresFromPressure(p: number | null): CoherentHealth {
  if (p === null || !Number.isFinite(p)) {
    return { score: 100, severity: 'healthy', provisional: true, reason: 'waiting for pressure data' };
  }
  const score = Math.round(Math.max(0, Math.min(100, ((p - 0.9) / (2.3 - 0.9)) * 100)));
  const severity = p >= 2.0 ? 'healthy' : p >= 1.6 ? 'advisory' : 'critical';
  return {
    score,
    severity,
    provisional: true,
    reason:
      severity === 'healthy'
        ? `pressure ${p.toFixed(2)} bar is healthy`
        : severity === 'advisory'
          ? `pressure ${p.toFixed(2)} bar is low`
          : `pressure ${p.toFixed(2)} bar — tire is flat`,
  };
}

/** Brakes: wear_fraction 0 healthy -> 1 worn out. */
function brakesFromWear(wearFrac: number | null): CoherentHealth {
  if (wearFrac === null || !Number.isFinite(wearFrac)) {
    return { score: 100, severity: 'healthy', provisional: true, reason: 'waiting for brake data' };
  }
  const pct = wearFrac * 100;
  const score = Math.round(Math.max(0, Math.min(100, 100 - pct)));
  const severity = pct <= 60 ? 'healthy' : pct <= 85 ? 'advisory' : 'critical';
  return {
    score,
    severity,
    provisional: true,
    reason:
      severity === 'healthy'
        ? `brake wear ${pct.toFixed(0)}% is healthy`
        : severity === 'advisory'
          ? `brake wear ${pct.toFixed(0)}% is elevated`
          : `brake wear ${pct.toFixed(0)}% — brakes worn out`,
  };
}

export interface LiveSignals {
  batteryVoltage: number | null;
  /** Battery SoH loss from simulator ground truth (0..1), when available. */
  batteryWearFrac?: number | null;
  tirePressure: number | null;
  /** Per-wheel pressures (bar); the tires aggregate uses the worst wheel. */
  tirePressures?: Partial<Record<Wheel, number | null>>;
  brakeWearFrac: number | null;
}

/**
 * Merge the authoritative PM message (when present) with live-derived
 * provisional health. `component` is one of the PM components.
 */
export function coherentHealth(
  component: 'battery' | 'brake' | 'tires',
  pm: PmMessage | undefined,
  live: LiveSignals,
): CoherentHealth {
  if (
    component === 'battery' &&
    live.batteryWearFrac !== null &&
    live.batteryWearFrac !== undefined &&
    Number.isFinite(live.batteryWearFrac) &&
    live.batteryWearFrac >= 1
  ) {
    return batteryFromWear(live.batteryWearFrac);
  }
  if (pm) {
    return {
      score: pm.health_score,
      severity: pm.severity,
      provisional: false,
      reason: pm.explanation,
    };
  }
  switch (component) {
    case 'battery': {
      if (live.batteryWearFrac !== null && live.batteryWearFrac !== undefined && Number.isFinite(live.batteryWearFrac)) {
        return batteryFromWear(live.batteryWearFrac);
      }
      return batteryFromVoltage(live.batteryVoltage);
    }
    case 'tires': {
      // Aggregate from per-wheel pressures when available: the worst wheel
      // drives the badge so a single flat tire is never masked by four
      // healthy ones. Falls back to the legacy single-channel pressure.
      const wheels = live.tirePressures ?? {};
      const values = WHEELS.map((w) => wheels[w]).filter(
        (p): p is number => p !== null && p !== undefined && Number.isFinite(p)
      );
      if (values.length === 0) return tiresFromPressure(live.tirePressure);
      const worst = Math.min(...values);
      return tiresFromPressure(worst);
    }
    case 'brake': return brakesFromWear(live.brakeWearFrac);
  }
}

/**
 * User-friendly + technical alert text for a PM message. The detector's
 * explanation is terse/technical ("EWMA 11.13 V < 12.2 V (action)"); this
 * produces a plain-language headline ("Battery is failing") plus the
 * technical evidence so both a demo audience and an engineer get what they
 * need. Falls back to the raw explanation when the shape is unexpected.
 */
export function friendlyAlert(msg: Pick<PmMessage, 'component' | 'severity' | 'explanation' | 'wheel'>): {
  headline: string;
  detail: string;
} {
  const comp = msg.component === 'tires' ? (msg.wheel ? `Tire ${msg.wheel.toUpperCase()}` : 'Tires') : msg.component === 'brake' ? (msg.wheel ? `Brake pad ${msg.wheel.toUpperCase()}` : 'Brakes') : 'Battery';
  const sev = msg.severity;
  const headline =
    sev === 'critical'
      ? `${comp} has failed — needs attention now`
      : sev === 'action'
        ? `${comp} is failing — action required`
        : sev === 'advisory'
          ? `${comp} shows early signs of wear`
          : `${comp} is healthy`;
  const detail = msg.explanation || 'No anomaly detected.';
  return { headline, detail };
}

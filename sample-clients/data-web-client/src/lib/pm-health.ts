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
  tirePressure: number | null;
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
  if (pm) {
    return {
      score: pm.health_score,
      severity: pm.severity,
      provisional: false,
      reason: pm.explanation,
    };
  }
  switch (component) {
    case 'battery': return batteryFromVoltage(live.batteryVoltage);
    case 'tires': return tiresFromPressure(live.tirePressure);
    case 'brake': return brakesFromWear(live.brakeWearFrac);
  }
}

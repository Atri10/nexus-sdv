import { describe, expect, it } from 'bun:test';
import {
  clearPmState,
  coherentHealth,
  deriveDeathCause,
  liveSignalsFromSimulator,
  pmMessageFromSubject,
  worstWheel,
  type CoherentHealth,
} from './pm-health';
import type { PmMessage } from './pm-types';

describe('pmMessageFromSubject', () => {
  it('parses a 4-token tires subject into vin/component/wheel', () => {
    expect(pmMessageFromSubject('pm.VIN1009.tires.fl')).toEqual({
      vin: 'VIN1009',
      component: 'tires',
      wheel: 'fl',
    });
  });

  it('parses a 4-token brake subject into pad', () => {
    expect(pmMessageFromSubject('pm.VIN1002.brake.rr')).toEqual({
      vin: 'VIN1002',
      component: 'brake',
      wheel: 'rr',
    });
  });

  it('parses a 3-token battery subject with no wheel', () => {
    expect(pmMessageFromSubject('pm.VIN1009.battery')).toEqual({
      vin: 'VIN1009',
      component: 'battery',
      wheel: undefined,
    });
  });

  it('rejects non-pm subjects and unknown components', () => {
    expect(pmMessageFromSubject('telemetry.VIN1009')).toBeNull();
    expect(pmMessageFromSubject('pm.VIN1009.gearbox')).toBeNull();
    expect(pmMessageFromSubject('pm')).toBeNull();
  });
});

describe('deriveDeathCause', () => {
  it('identifies the first flat wheel from ground truth', () => {
    expect(deriveDeathCause({
      tires: {
        FL: { pressure_bar: 1.0 },
        FR: { pressure_bar: 2.3 },
        RL: { pressure_bar: 2.3 },
        RR: { pressure_bar: 2.3 },
      },
      battery: { days_to_failure: 30 },
    })).toEqual({ component: 'tires', wheel: 'FL', pressureBar: 1 });
  });

  it('identifies a battery at its failure horizon', () => {
    expect(deriveDeathCause({ battery: { days_to_failure: 0 } })).toEqual({ component: 'battery' });
  });

  it('returns unknown when the status payload has no matching evidence', () => {
    expect(deriveDeathCause({ battery: { days_to_failure: 5 } })).toEqual({ component: 'unknown' });
  });
});

describe('worstWheel', () => {
  const entries: PmMessage[] = [
    { vin: 'VIN1', component: 'tires', wheel: 'fl', health_score: 72, severity: 'advisory', evidence: {}, explanation: 'a', timestamp: 't1' },
    { vin: 'VIN1', component: 'tires', wheel: 'fr', health_score: 45, severity: 'critical', evidence: {}, explanation: 'b', timestamp: 't2' },
    { vin: 'VIN1', component: 'tires', wheel: 'rr', health_score: 90, severity: 'healthy', evidence: {}, explanation: 'c', timestamp: 't3' },
  ];

  it('returns the min-score entry', () => {
    const worst = worstWheel(entries);
    expect(worst?.health_score).toBe(45);
    expect(worst?.wheel).toBe('fr');
  });

  it('returns null for empty input', () => {
    expect(worstWheel([])).toBeNull();
  });

  it('returns the only entry for a single-element list', () => {
    expect(worstWheel([entries[2]])?.health_score).toBe(90);
  });
});

describe('coherentHealth tires aggregate (worst wheel drives the badge)', () => {
  const msg = (health_score: number, severity: CoherentHealth['severity'], explanation: string): PmMessage => ({
    vin: 'VIN1', component: 'tires', health_score, severity, evidence: {}, explanation, timestamp: 't',
  });

  it('uses the PM message when present (authoritative)', () => {
    const h = coherentHealth('tires', msg(55, 'action', 'FL below floor'), {
      batteryVoltage: null, tirePressure: null, brakeWearFrac: null,
    });
    expect(h.score).toBe(55);
    expect(h.severity).toBe('action');
    expect(h.provisional).toBe(false);
    expect(h.reason).toBe('FL below floor');
  });

  it('aggregates per-wheel pressures to the worst wheel for provisional health', () => {
    const h = coherentHealth('tires', undefined, {
      batteryVoltage: null,
      tirePressure: 2.3,
      brakeWearFrac: null,
      tirePressures: { FL: 1.1, FR: 2.3, RL: 2.3, RR: 2.3 },
    });
    // 1.1 bar maps to score ~14, critical — the badge must show the flat wheel.
    expect(h.score).toBeLessThanOrEqual(15);
    expect(h.severity).toBe('critical');
    expect(h.provisional).toBe(true);
  });

  it('falls back to the legacy single pressure when no per-wheel map is given', () => {
    const h = coherentHealth('tires', undefined, {
      batteryVoltage: null,
      tirePressure: 2.3,
      brakeWearFrac: null,
    });
    expect(h.score).toBe(100);
    expect(h.severity).toBe('healthy');
  });
});

describe('coherentHealth battery ground truth', () => {
  it('shows zero health at terminal battery wear even with a stale PM message', () => {
    const h = coherentHealth('battery', {
      vin: 'VIN1', component: 'battery', health_score: 55, severity: 'action',
      evidence: {}, explanation: 'last detector poll', timestamp: 't',
    }, {
      batteryVoltage: 12.0,
      batteryWearFrac: 1,
      tirePressure: null,
      brakeWearFrac: null,
    });
    expect(h.score).toBe(0);
    expect(h.severity).toBe('critical');
    expect(h.provisional).toBe(false);
    expect(h.reason).toContain('battery health is 0%');
  });
});

describe('liveSignalsFromSimulator', () => {
  it('normalizes one simulator frame for every PM component', () => {
    const signals = liveSignalsFromSimulator({
      live: { battery_voltage: 12.1, tire_pressure_bar: 2.3 },
      ground_truth: {
        battery: { wear_fraction: 0.4 },
        tires: {
          FL: { pressure_bar: 1.1 },
          FR: { pressure_bar: 2.3 },
          RL: { pressure_bar: 2.3 },
          RR: { pressure_bar: 2.3 },
        },
        brakes: {
          FL: { wear_fraction: 0.2 },
          FR: { wear_fraction: 0.1 },
        },
      },
    });
    expect(signals.batteryVoltage).toBe(12.1);
    expect(signals.batteryWearFrac).toBe(0.4);
    expect(signals.tirePressures?.FL).toBe(1.1);
    expect(signals.brakeWearFrac).toBe(0.2);
  });

  it('lets the same normalized frame produce the same battery health score', () => {
    const signals = liveSignalsFromSimulator({
      live: { battery_voltage: 12.1 },
      ground_truth: { battery: { wear_fraction: 0.4 } },
    });
    expect(coherentHealth('battery', undefined, signals).score).toBe(60);
  });
});

describe('clearPmState', () => {
  it('empties messages, health and sample buffers', () => {
    let messages: PmMessage[] = [{ vin: 'VIN1', component: 'battery', health_score: 40, severity: 'critical', evidence: {}, explanation: 'x', timestamp: 't' }];
    let health: Record<string, CoherentHealth> = { battery: { score: 40, severity: 'critical', provisional: false, reason: 'x' } };
    let samples: number[] = [1, 2, 3];
    clearPmState({
      setMessages: (m) => { messages = m; },
      setHealth: (h) => { health = h; },
      setSamples: (s) => { samples = s as number[]; },
    });
    expect(messages).toEqual([]);
    expect(health).toEqual({});
    expect(samples).toEqual([]);
  });

  it('works without a health setter (derived health pages)', () => {
    let messages: PmMessage[] = [{ vin: 'VIN1', component: 'battery', health_score: 40, severity: 'critical', evidence: {}, explanation: 'x', timestamp: 't' }];
    let samples: string[] = ['a'];
    expect(() =>
      clearPmState<string>({
        setMessages: (m) => { messages = m; },
        setSamples: (s) => { samples = s; },
      })
    ).not.toThrow();
    expect(messages).toEqual([]);
    expect(samples).toEqual([]);
  });
});

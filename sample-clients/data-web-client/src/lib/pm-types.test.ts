import { parsePmMessage, severityColor } from './pm-types';

describe('parsePmMessage', () => {
  it('parses a valid message', () => {
    const raw = JSON.stringify({ vin: 'VIN1001', component: 'battery', health_score: 62, severity: 'advisory', evidence: { ewma_voltage: '12.38' }, explanation: 'Resting voltage 12.38 V.', timestamp: '2026-08-09T00:00:00Z' });
    const m = parsePmMessage(raw);
    expect(m?.severity).toBe('advisory');
    expect(m?.health_score).toBe(62);
  });
  it('rejects malformed messages', () => {
    expect(parsePmMessage('not json')).toBeNull();
    expect(parsePmMessage(JSON.stringify({ vin: 'x' }))).toBeNull(); // missing fields
  });
});

describe('severityColor', () => {
  it('maps severities to colors', () => {
    expect(severityColor('healthy')).toBeDefined();
    expect(severityColor('critical')).toMatch(/red|rose/);
  });
});

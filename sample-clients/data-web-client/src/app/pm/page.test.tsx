import { describe, expect, it, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { PmValidationCard, severityCounts, SEVERITIES, type PmValidationData } from './page';
import type { PmMessage } from '@/lib/pm-types';

describe('severityCounts', () => {
  const base = (overrides: Partial<PmMessage>): PmMessage => ({
    vin: 'VIN1001',
    component: 'battery',
    health_score: 62,
    severity: 'advisory',
    evidence: {},
    explanation: 'x',
    timestamp: '2026-08-09T00:00:00Z',
    ...overrides,
  });

  it('counts the latest message per VIN into severity bands', () => {
    const messages = [
      base({ vin: 'VIN1', component: 'battery', severity: 'critical' }),
      base({ vin: 'VIN2', component: 'battery', severity: 'advisory' }),
      base({ vin: 'VIN1', component: 'battery', severity: 'healthy', timestamp: '2026-08-08T00:00:00Z' }), // older — ignored
      base({ vin: 'VIN3', component: 'battery', severity: 'healthy' }),
      base({ vin: 'VIN9', component: 'tires', severity: 'critical' }), // other component — ignored
    ];
    const counts = severityCounts(messages, 'battery');
    expect(counts).toEqual({ healthy: 1, advisory: 1, action: 0, critical: 1 });
    expect(Object.keys(counts).sort()).toEqual([...SEVERITIES].sort());
  });
});

describe('PmValidationCard', () => {
  it('fetches and renders precision/recall/lead from pm-validation.json', async () => {
    const json: PmValidationData = {
      generated: '2026-08-09',
      simulated_vins: 20,
      components: {
        battery: { precision: 0.82, recall: 0.75, mean_lead_days: 21 },
        brake: { precision: 0.9, recall: 0.85, mean_lead_days: 34 },
        tires: { precision: 0.8, recall: 0.7, mean_lead_days: 12 },
      },
    };
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve(json) }));
    // @ts-expect-error minimal stub
    globalThis.fetch = fetchMock;

    render(<PmValidationCard />);
    await waitFor(() => expect(screen.getByText('0.82')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/pm-validation.json', expect.anything());
    expect(screen.getByText('battery')).toBeInTheDocument();
    expect(screen.getByText('brake')).toBeInTheDocument();
    expect(screen.getByText('tires')).toBeInTheDocument();
    expect(screen.getByText('0.85')).toBeInTheDocument();
    expect(screen.getByText('34')).toBeInTheDocument();
    expect(screen.getByText(/20 simulated VINs/)).toBeInTheDocument();
    expect(screen.getByText('simulator ground truth')).toBeInTheDocument();
  });

  it('labels the card as a placeholder when the JSON self-identifies', async () => {
    const json: PmValidationData = {
      generated: '2026-08-09',
      placeholder: true,
      simulated_vins: 20,
      components: {
        battery: { precision: 0.82, recall: 0.75, mean_lead_days: 21 },
      },
    };
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve(json) }));
    // @ts-expect-error minimal stub
    globalThis.fetch = fetchMock;

    render(<PmValidationCard />);
    await waitFor(() => expect(screen.getByText('placeholder')).toBeInTheDocument());
    // The placeholder file must not present itself as real ground truth.
    expect(screen.queryByText('simulator ground truth')).not.toBeInTheDocument();
  });

  it('shows an error state when the fetch fails', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: false, status: 404 }));
    // @ts-expect-error minimal stub
    globalThis.fetch = fetchMock;

    render(<PmValidationCard />);
    await waitFor(() => expect(screen.getByText(/Could not load pm-validation.json/)).toBeInTheDocument());
  });
});

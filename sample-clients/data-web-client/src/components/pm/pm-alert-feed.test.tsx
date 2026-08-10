import { describe, expect, it } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { PmAlertFeed } from './pm-alert-feed';
import type { PmMessage } from '@/lib/pm-types';

const make = (overrides: Partial<PmMessage>): PmMessage => ({
  vin: 'VIN1001',
  component: 'battery',
  health_score: 62,
  severity: 'advisory',
  evidence: { ewma_voltage: '12.38', slope_mv_day: '-0.61' },
  explanation: 'Resting voltage 12.38 V, drifting -0.61 mV/day.',
  timestamp: '2026-08-09T00:00:00Z',
  ...overrides,
});

describe('PmAlertFeed', () => {
  it('renders newest-first messages with severity badge and evidence details', () => {
    const messages = [
      make({ vin: 'VIN1002', severity: 'critical', timestamp: '2026-08-10T00:00:00Z' }),
      make({ vin: 'VIN1001', timestamp: '2026-08-09T00:00:00Z' }),
    ];
    const { container } = render(<PmAlertFeed messages={messages} />);
    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].textContent).toContain('VIN1002');
    expect(rows[1].textContent).toContain('VIN1001');

    // Severity badges tinted with the real severity color (inline style).
    expect(screen.getByText('critical').style.color).toBe('#DC2626');
    expect(screen.getAllByText('advisory')[0].style.color).toBe('#F59E0B');

    // Evidence in a collapsible <details>.
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.querySelector('pre')?.textContent).toContain('ewma_voltage');
    fireEvent.click(screen.getAllByText('evidence')[0]);
    expect(details?.open).toBe(true);
  });

  it('caps the visible list at 50', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      make({ vin: `VIN${1000 + i}`, timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString() }),
    );
    const { container } = render(<PmAlertFeed messages={many} />);
    // The feed hard-caps at 50 — extras never render, so no "Show more" pager.
    expect(container.querySelectorAll('li')).toHaveLength(50);
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no messages', () => {
    render(<PmAlertFeed messages={[]} />);
    expect(screen.getByText(/No predictive-maintenance alerts yet/)).toBeInTheDocument();
  });
});

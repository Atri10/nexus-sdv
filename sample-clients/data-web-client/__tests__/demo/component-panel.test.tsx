import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentPanel } from '@/components/demo/component-panel';
import type { ComponentStatus } from '@/lib/demo-control';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery',
    label: 'Battery',
    enabled: true,
    sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }],
  },
  {
    id: 'cabin',
    label: 'Cabin',
    enabled: false,
    sensors: [{ name: 'make', label: 'Make' }],
  },
];

describe('ComponentPanel', () => {
  it('renders a card per component with status and sensors', () => {
    render(<ComponentPanel components={COMPONENTS} simulatorVin="VIN1001" busy={false} onToggle={() => {}} />);
    expect(screen.getByText('Battery')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/battery\.voltage/)).toBeInTheDocument();
    expect(screen.getByText(/· V/)).toBeInTheDocument();
  });

  it('shows Offline when the simulator is unknown', () => {
    render(<ComponentPanel components={COMPONENTS} simulatorVin={null} busy={false} onToggle={() => {}} />);
    expect(screen.getAllByText('Offline')).toHaveLength(2);
  });

  it('calls onToggle with the new desired state', () => {
    const onToggle = jest.fn();
    render(<ComponentPanel components={COMPONENTS} simulatorVin="VIN1001" busy={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch', { name: /cabin/i }));
    expect(onToggle).toHaveBeenCalledWith('cabin', true);
  });

  it('renders an empty hint when nothing is discovered', () => {
    render(<ComponentPanel components={null} simulatorVin={null} busy={false} onToggle={() => {}} />);
    expect(screen.getByText(/No components discovered/)).toBeInTheDocument();
  });
});

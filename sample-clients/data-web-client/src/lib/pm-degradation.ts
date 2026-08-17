export const DEGRADATION_COMPONENTS = ['battery', 'tires', 'brake'] as const;
export type DegradationComponent = (typeof DEGRADATION_COMPONENTS)[number];

export const FAULT_SCENARIOS = ['healthy', 'battery', 'tires', 'brake'] as const;
export type FaultScenario = (typeof FAULT_SCENARIOS)[number];

export type FaultIntensity = 'degrading' | 'critical';

export interface DegradationCommand {
  component: DegradationComponent;
  preset: 'healthy' | FaultIntensity;
}

/**
 * Convert the user-facing fault scenario into complete simulator state. Every
 * component is returned so switching from tire failure to battery failure
 * cannot leave the previous component faulty in the background.
 */
export function commandsForScenario(
  scenario: FaultScenario,
  intensity: FaultIntensity,
): DegradationCommand[] {
  return DEGRADATION_COMPONENTS.map((component) => ({
    component,
    preset: scenario === component ? intensity : 'healthy',
  }));
}

export const FAULT_SCENARIO_LABELS: Record<FaultScenario, string> = {
  healthy: 'No induced fault',
  battery: 'Battery failure',
  tires: 'Tire failure',
  brake: 'Brake wear',
};

export const FAULT_SCENARIO_HELP: Record<FaultScenario, string> = {
  healthy: 'All three modeled components remain on their healthy baseline.',
  battery: 'Only the 12V battery degrades; the vehicle stops when battery end-of-life is reached.',
  tires: 'Only tires degrade; the first flat wheel stops the vehicle.',
  brake: 'Only brake pads wear faster; the vehicle keeps driving so PM brake alerts can be inspected.',
};

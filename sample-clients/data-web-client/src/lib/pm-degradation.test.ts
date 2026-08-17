import { describe, expect, test } from 'bun:test';
import { commandsForScenario } from '@/lib/pm-degradation';

describe('commandsForScenario', () => {
  test('selects only the battery for a critical battery test', () => {
    expect(commandsForScenario('battery', 'critical')).toEqual([
      { component: 'battery', preset: 'critical' },
      { component: 'tires', preset: 'healthy' },
      { component: 'brake', preset: 'healthy' },
    ]);
  });

  test('resets every modeled component for the healthy scenario', () => {
    expect(commandsForScenario('healthy', 'degrading')).toEqual([
      { component: 'battery', preset: 'healthy' },
      { component: 'tires', preset: 'healthy' },
      { component: 'brake', preset: 'healthy' },
    ]);
  });
});

import { describe, expect, it } from '@jest/globals';
import {
  qualifierOf,
  componentForSignal,
  signalsForComponent,
  unitForSignal,
  componentsForSeries,
  stableComponents,
} from '@/lib/telemetry-discovery';
import type { ComponentStatus } from '@/lib/demo-control';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery',
    label: 'Battery',
    enabled: true,
    sensors: [
      { name: 'battery.voltage', label: 'Voltage', unit: 'V' },
      { name: 'battery.soc', label: 'SoC', unit: '%' },
    ],
  },
  { id: 'cabin', label: 'Cabin', enabled: false, sensors: [{ name: 'make', label: 'Make' }] },
];

describe('telemetry discovery', () => {
  it('strips family prefixes', () => {
    expect(qualifierOf('dynamic:battery.voltage')).toBe('battery.voltage');
    expect(qualifierOf('static:make')).toBe('make');
    expect(qualifierOf('battery.soc')).toBe('battery.soc');
  });

  it('maps a signal qualifier to its component', () => {
    expect(componentForSignal(COMPONENTS, 'battery.voltage')?.id).toBe('battery');
    expect(componentForSignal(COMPONENTS, 'make')?.id).toBe('cabin');
    expect(componentForSignal(COMPONENTS, 'ENGINE_RPM')).toBeUndefined();
    expect(componentForSignal(null, 'battery.voltage')).toBeUndefined();
  });

  it('returns sensors for a component', () => {
    expect(signalsForComponent(COMPONENTS, 'battery')).toHaveLength(2);
    expect(signalsForComponent(COMPONENTS, 'missing')).toEqual([]);
  });

  it('resolves units from discovered metadata', () => {
    expect(unitForSignal(COMPONENTS, 'battery.voltage')).toBe('V');
    expect(unitForSignal(COMPONENTS, 'make')).toBeUndefined();
  });

  it('groups series keys by component', () => {
    const series = [
      { key: 'VIN1|dynamic:battery.voltage', column: 'dynamic:battery.voltage' },
      { key: 'VIN1|static:make', column: 'static:make' },
      { key: 'VIN1|dynamic:ENGINE_RPM', column: 'dynamic:ENGINE_RPM' },
    ] as ChartSeries[];
    const groups = componentsForSeries(COMPONENTS, series);
    expect(groups.get('battery')?.map((s) => s.key)).toEqual(['VIN1|dynamic:battery.voltage']);
    expect(groups.get('cabin')?.map((s) => s.key)).toEqual(['VIN1|static:make']);
    expect(groups.get('unassigned')?.map((s) => s.key)).toEqual(['VIN1|dynamic:ENGINE_RPM']);
  });

  it('stableComponents sorts deterministically regardless of wire order', () => {
    const shuffled = [...COMPONENTS].reverse(); // cabin, battery
    const sorted = stableComponents(shuffled);
    expect(sorted?.map((c) => c.id)).toEqual(['battery', 'cabin']);
    expect(stableComponents(null)).toBeNull();
    // input array is not mutated
    expect(shuffled.map((c) => c.id)).toEqual(['cabin', 'battery']);
  });
});

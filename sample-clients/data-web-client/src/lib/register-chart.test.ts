import { describe, it, expect } from 'bun:test';
import { registerChart } from '@/lib/register-chart';

describe('registerChart', () => {
  it('is idempotent and does not throw', () => {
    expect(() => {
      registerChart();
      registerChart();
    }).not.toThrow();
  });
});

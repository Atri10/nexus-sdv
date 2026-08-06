import { describe, expect, it } from '@jest/globals';
import { stableAxisRange } from '@/lib/chart-range';

describe('stableAxisRange', () => {
  it('pads the min/max by 12%', () => {
    const r = stableAxisRange([{ y: 10 }, { y: 20 }, { y: 15 }]);
    expect(r).toEqual({ min: 10 - 1.2, max: 20 + 1.2 });
  });

  it('ignores null and non-finite values', () => {
    const r = stableAxisRange([{ y: null }, { y: 5 }, { y: 6 }, { y: Number.NaN }]);
    expect(r).toEqual({ min: 5 - 0.12, max: 6 + 0.12 });
  });

  it('returns null without any usable point', () => {
    expect(stableAxisRange([])).toBeNull();
    expect(stableAxisRange([{ y: null }, { y: undefined }])).toBeNull();
  });

  it('opens a window for constant signals', () => {
    const r = stableAxisRange([{ y: 12.5 }, { y: 12.5 }]);
    expect(r!.min).toBeLessThan(12.5);
    expect(r!.max).toBeGreaterThan(12.5);
    expect(r!.max - r!.min).toBeGreaterThan(0.2); // padded span of the ≥1 m window
  });

  it('is stable: appending a value inside the window does not change the range', () => {
    const before = stableAxisRange([{ y: 10 }, { y: 20 }]);
    const after = stableAxisRange([{ y: 10 }, { y: 20 }, { y: 15 }]);
    expect(after).toEqual(before);
  });
});

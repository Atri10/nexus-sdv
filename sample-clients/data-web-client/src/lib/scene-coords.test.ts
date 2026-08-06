import { afterEach, describe, expect, it } from 'bun:test';
import { projectLatLng, webglSupported } from '@/lib/scene-coords';

// ~111.19 km per degree of latitude; at metersPerUnit=10, 1° ≈ 1111.9 units.
const DEG_M = 111190;
const M_PER_UNIT = 10;
const ORIGIN_LAT = 41.49;

// Implementation constant: mean Earth radius in meters.
const R = 6371000;

describe('projectLatLng', () => {
  it('projects the origin to (0, 0)', () => {
    const { x, z } = projectLatLng(ORIGIN_LAT, -81.7, ORIGIN_LAT, -81.7);
    // -0 and 0 are numerically identical; toBeCloseTo accepts either.
    expect(x).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(0, 12);
  });

  it('projects 1° north of the origin to a negative z (north = screen up)', () => {
    const { x, z } = projectLatLng(ORIGIN_LAT + 1, -81.7, ORIGIN_LAT, -81.7);
    expect(x).toBeCloseTo(0, 6);
    // 1° latitude ≈ 11119 m → 1111.9 units at 10 m/unit
    expect(z).toBeCloseTo(-DEG_M / M_PER_UNIT, -1);
  });

  it('projects 1° east of the origin to a positive x (cos-scaled by origin latitude)', () => {
    const { x, z } = projectLatLng(ORIGIN_LAT, -80.7, ORIGIN_LAT, -81.7);
    // 1° longitude ≈ 11119 × cos(originLat) m → units at 10 m/unit
    const expected = ((Math.PI / 180) * R * Math.cos((ORIGIN_LAT * Math.PI) / 180)) / M_PER_UNIT;
    expect(x).toBeCloseTo(expected, -1);
    expect(z).toBeCloseTo(0, 6);
  });

  it('scales with metersPerUnit', () => {
    const coarse = projectLatLng(ORIGIN_LAT + 1, -81.7, ORIGIN_LAT, -81.7, 100);
    expect(coarse.z).toBeCloseTo(-DEG_M / 100, -1);
  });
});

describe('webglSupported', () => {
  const savedDocument = globalThis.document;

  // Test-only: swap the happy-dom document global to exercise the guard and
  // canvas stub paths. webglSupported reads `document` at call time.
  const setDocument = (value: typeof savedDocument | undefined) => {
    (globalThis as { document: typeof savedDocument | undefined }).document = value;
  };

  afterEach(() => {
    setDocument(savedDocument);
  });

  it('returns false when document is undefined', () => {
    setDocument(undefined);
    expect(webglSupported()).toBe(false);
  });

  it('returns true when a webgl2 context can be created', () => {
    const getContext = (kind: string) => (kind === 'webgl2' ? {} : null);
    setDocument({ createElement: () => ({ getContext }) } as typeof savedDocument);
    expect(webglSupported()).toBe(true);
  });

  it('returns true when only a webgl context can be created', () => {
    const getContext = (kind: string) => (kind === 'webgl' ? {} : null);
    setDocument({ createElement: () => ({ getContext }) } as typeof savedDocument);
    expect(webglSupported()).toBe(true);
  });

  it('returns false when canvas.getContext returns null', () => {
    const getContext = () => null;
    setDocument({ createElement: () => ({ getContext }) } as typeof savedDocument);
    expect(webglSupported()).toBe(false);
  });

  it('returns false when canvas.getContext throws', () => {
    const getContext = () => {
      throw new Error('no gpu');
    };
    setDocument({ createElement: () => ({ getContext }) } as typeof savedDocument);
    expect(webglSupported()).toBe(false);
  });
});

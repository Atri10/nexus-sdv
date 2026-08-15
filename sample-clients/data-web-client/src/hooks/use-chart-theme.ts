'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

export interface ChartThemeColors {
  grid: string;
  ticks: string;
  legend: string;
  title: string;
  /** Mono family used for all chart text (ticks, axis titles, tooltips). */
  fontFamily: string;
  /** Accent color for the HUD crosshair. */
  crosshair: string;
}

const FALLBACK_FONT_FAMILY = 'JetBrains Mono, monospace';

/**
 * Resolved body font, cached module-wide so every chart shares one value.
 * Resolution waits on `document.fonts.ready` so @font-face fonts (Orbitron,
 * JetBrains Mono) are loaded before getComputedStyle samples the body;
 * falls back to the HUD mono stack when unavailable (SSR / no document).
 */
let cachedFontFamily: string | null = null;
let fontFamilyPromise: Promise<string> | null = null;

function resolveFontFamily(): Promise<string> {
  if (cachedFontFamily) return Promise.resolve(cachedFontFamily);
  fontFamilyPromise ??= (async () => {
    try {
      await document.fonts?.ready;
      const computed = getComputedStyle(document.body).fontFamily;
      cachedFontFamily = computed && computed.trim() ? computed : FALLBACK_FONT_FAMILY;
    } catch {
      cachedFontFamily = FALLBACK_FONT_FAMILY;
    }
    return cachedFontFamily;
  })();
  return fontFamilyPromise;
}

export function useChartTheme(): ChartThemeColors {
  const { resolvedTheme } = useTheme();
  const [fontFamily, setFontFamily] = useState<string>(
    cachedFontFamily ?? FALLBACK_FONT_FAMILY,
  );

  // Resolve the body font once per page load, then swap it into the theme.
  // This is a genuine external side effect (fonts.ready + computed style),
  // so the state update lives in a promise callback — not the effect body —
  // which keeps the react-hooks linter happy.
  useEffect(() => {
    if (cachedFontFamily) return;
    let active = true;
    resolveFontFamily().then((family) => {
      if (active) setFontFamily(family);
    });
    return () => {
      active = false;
    };
  }, []);

  // Palette follows the resolved theme — derived during render (no
  // setState-in-effect), with fontFamily/crosshair theme-stable accents.
  const dark = resolvedTheme === 'dark';
  return {
    grid: dark ? '#374151' : '#e5e7eb',
    ticks: dark ? '#9ca3af' : '#6b7280',
    legend: dark ? '#e5e7eb' : '#374151',
    title: dark ? '#f9fafb' : '#111827',
    fontFamily,
    crosshair: '#22D3EE',
  };
}

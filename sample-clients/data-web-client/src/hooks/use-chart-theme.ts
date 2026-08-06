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
  const [colors, setColors] = useState<ChartThemeColors>({
    grid: '#e5e7eb',
    ticks: '#6b7280',
    legend: '#374151',
    title: '#111827',
    fontFamily: cachedFontFamily ?? FALLBACK_FONT_FAMILY,
    crosshair: '#22D3EE',
  });

  // Palette follows the resolved theme; fontFamily and crosshair are
  // theme-stable accents.
  useEffect(() => {
    const dark = resolvedTheme === 'dark';
    setColors((prev) => ({
      ...prev,
      grid: dark ? '#374151' : '#e5e7eb',
      ticks: dark ? '#9ca3af' : '#6b7280',
      legend: dark ? '#e5e7eb' : '#374151',
      title: dark ? '#f9fafb' : '#111827',
    }));
  }, [resolvedTheme]);

  // Resolve the body font once per page load, then swap it into the theme.
  useEffect(() => {
    if (cachedFontFamily) return;
    let active = true;
    resolveFontFamily().then((family) => {
      if (active) setColors((prev) => ({ ...prev, fontFamily: family }));
    });
    return () => {
      active = false;
    };
  }, []);

  return colors;
}

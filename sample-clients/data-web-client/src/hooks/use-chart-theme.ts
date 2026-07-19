'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

export interface ChartThemeColors {
  grid: string;
  ticks: string;
  legend: string;
  title: string;
}

export function useChartTheme(): ChartThemeColors {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<ChartThemeColors>({
    grid: '#e5e7eb',
    ticks: '#6b7280',
    legend: '#374151',
    title: '#111827',
  });

  useEffect(() => {
    const dark = resolvedTheme === 'dark';
    setColors({
      grid: dark ? '#374151' : '#e5e7eb',
      ticks: dark ? '#9ca3af' : '#6b7280',
      legend: dark ? '#e5e7eb' : '#374151',
      title: dark ? '#f9fafb' : '#111827',
    });
  }, [resolvedTheme]);

  return colors;
}
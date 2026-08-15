'use client';

import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSyncExternalStore } from 'react';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Hydration guard: the theme is only known client-side; rendering the
  // toggle icon before mount would mismatch SSR HTML. useSyncExternalStore
  // with a constant snapshot flips to true after the first client render
  // without a setState-in-effect (react-hooks lint).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  if (!mounted) return <Button variant="ghost" size="icon" aria-label="Toggle theme" />;
  const isDark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}
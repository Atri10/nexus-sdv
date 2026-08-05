# Theming System

## Overview
The application uses `next-themes` with Tailwind v4 CSS variables for dark/light mode support. Theme preference is persisted in `localStorage` and respects system preference on first load.

## Architecture

### Provider
- **`ThemeProvider`** (`src/components/theme-provider.tsx`) — Wraps `next-themes` `ThemeProvider`
  - `attribute="class"` — toggles `.dark` on `<html>`
  - `defaultTheme="system"` — respects `prefers-color-scheme`
  - `enableSystem` — watches media query changes
  - `disableTransitionOnChange` — prevents flash during toggle

### Toggle
- **`ThemeToggle`** (`src/components/theme-toggle.tsx`) — Sun/Moon button
  - Uses `useTheme()` from `next-themes`
  - Hydration guard (`useEffect(() => setMounted(true), [])`) — prevents SSR mismatch
  - Renders ghost icon button

### CSS Variables (globals.css)
```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
  --font-heading: var(--font-sans);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

Tokens are **oklch()** values; the `@theme inline` block maps them into Tailwind's `--color-*` namespace. HSL is not used. Add new tokens in `:root` / `.dark` in this file.

### Usage in Components
```tsx
// Semantic tokens (auto-adapts to dark/light)
<div className="bg-card text-card-foreground border-border" />

// Chart.js colors via useChartTheme()
const { grid, ticks, legend, title } = useChartTheme();
```

### shadcn/ui Primitive Mapping
All primitives use semantic tokens:
- `Button` → `bg-primary`, `hover:bg-primary/90`
- `Card` → `bg-card text-card-foreground border-border`
- `Badge` → `bg-secondary text-secondary-foreground`
- `Skeleton` → `bg-muted`
- `Tooltip` → `bg-popover text-popover-foreground`
- `Sonner Toaster` → inherits theme via `richColors`

### Dark Mode Persistence
- `localStorage.theme` — `'light' | 'dark' | 'system'`
- On load: reads `localStorage` → applies `.dark` class
- On toggle: updates `localStorage` + applies class
- System changes: only applies if theme === 'system'

### SSR / Hydration
- `ThemeProvider` runs on client only (`'use client'`)
- `ThemeToggle` uses hydration guard to prevent flash:
  ```tsx
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <Button variant="ghost" size="icon" />;
  ```

## Extending Tokens
Add new CSS variables in `:root` / `.dark` blocks in `globals.css`. Use semantic names (`--my-token`, `--my-token-foreground`) for consistency.

## Testing
- Theme toggle: verify `.dark` class toggles on `<html>`
- Persistence: reload page → theme persists
- System preference: change OS theme → app follows (when set to 'system')
- All primitives: verify colors adapt in both modes
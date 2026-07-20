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

@custom-variant dark (&:where(.dark, .dark *));

:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 221.2 83.2% 53.3%;
}

.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --primary: 217.2 91.2% 59.8%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 224.3 76.3% 48%;
}
```

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
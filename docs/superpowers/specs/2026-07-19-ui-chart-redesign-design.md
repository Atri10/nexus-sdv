# UI & Chart Redesign — Design Spec

- **Date:** 2026-07-19
- **Status:** Approved (design)
- **Author:** Engineering agent (brainstorming → spec)
- **Project:** nexus-sdv / `sample-clients/data-web-client` (Next.js 16, React 19, Tailwind v4, Chart.js 4)

## 1. Goal & Context

The data-web-client (Next.js) is functionally working but the UX is uneven and the
chart is disconnected from the rest of the page:

- The **chart is live-only** (WebSocket, last 100 points) and **ignores the time-range
  selector** and the historical **data table** — they never agree.
- Pages lack consistent layout, and there are **no loading / empty / error states**.
- The app has **no dark mode** and the shell (sidebar/header) is minimal.

This spec delivers a **whole-app, consistent redesign** (fleet, device detail, auth,
app shell) with **dark/light theming** and a **rebuilt chart** that unifies historical
+ live data and adds the requested chart capabilities.

### Decisions captured during brainstorming
- **Priority:** Holistic UI polish (with chart features in scope).
- **Scope:** Whole app, consistent redesign.
- **Chart features (selected):** historical + live unified, series toggle, line/area/bar
  switch, zoom/pan + crosshair, dual Y-axis, compare vehicles. (Export PNG/CSV and
  threshold/alert lines were *not* selected — explicitly out of scope.)
- **Approach:** Component library — **shadcn/ui** (Tailwind-native; extends the existing
  Tailwind v4 stack). Rejected Mantine (own styling engine conflicts with Tailwind v4);
  rejected a from-scratch design system (too much regression risk).

## 2. Approach

Adopt **shadcn/ui** (Tailwind v4 mode). shadcn copies Radix-based primitives into
`components/ui/`, reuses Tailwind v4 tokens, and provides dark mode via CSS variables.
No competing styling system is introduced. The chart stays on **Chart.js +
react-chartjs-2** (already in use) with the new **`chartjs-plugin-zoom`** for
zoom/pan; shadcn components are used only for surrounding controls and layout.

### New dependencies
- `next-themes` (theme provider: system preference + persistence)
- `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` (shadcn baseline)
- Radix primitives pulled in by shadcn `add` (button, card, select, switch, tabs,
  dialog, command, badge, separator, skeleton, tooltip, sonner, scroll-area, sheet,
  input, label)
- `cmdk` (command palette / device search)
- `sonner` (toasts for errors/retries)
- `chartjs-plugin-zoom` (zoom/pan)

## 3. Architecture & File Changes

### 3.1 Theming foundation
- Run `npx shadcn@latest init` (Tailwind v4 mode): creates `components.json`,
  `lib/utils.ts` (`cn`), and CSS variables (`--background`, `--foreground`, …) in
  `globals.css` under `:root` (light) and `.dark`.
- Add `@custom-variant dark (&:where(.dark, .dark *));` so Tailwind v4 dark utilities work.
- **`components/theme-provider.tsx`** — wraps `next-themes` `ThemeProvider`
  (`attribute="class"`, `defaultTheme="system"`, `enableSystem`). Mounted in
  `app/layout.tsx` around `{children}`.
- **`components/theme-toggle.tsx`** — sun/moon button using `useTheme`; lives in the header.

### 3.2 App shell & navigation
- **`components/app-layout.tsx`** — integrate `Sidebar` + header (with `ThemeToggle` and
  device `Command` search). Keep current route structure.
- **`components/sidebar.tsx`** — shadcn `Button`/active state via `usePathname`,
  `Separator` for dividers.
- **Device quick-search:** shadcn `Command` (`cmdk`) in a `Dialog`; queries
  `/api/devices` for suggestions + free-text VIN; navigates to `/device/[id]`.

### 3.3 Device detail page (`app/device/[id]/page.tsx`)
Restructure into `Card`-based sections:
1. Header: VIN + live `Badge` (connected/disconnected).
2. Time-range selector + **`ChartControls`** row.
3. **Chart `Card`** (historical + live).
4. `Tabs`: **Table / Map / Alerts** (data table, GPS map, scoring alerts).
- **`components/state-view.tsx`** — shared primitive rendering one of:
  - `loading` → `Skeleton`
  - `empty` → centered guidance Card ("No telemetry for VINxxx yet — publish data to
    see it.")
  - `error` → error Card + retry `Button`.
- Responsive: multi-column on desktop, single column on mobile.

### 3.4 Chart rework (core)
**`hooks/use-telemetry-data.ts`** — single source of truth:
- Inputs: `vin`, `range` (`'1h'|'6h'|'24h'|'7d'`), `compareVins: string[]`.
- On `range`/`vin`/`compareVins` change: `fetch('/api/telemetry/[vin]?start&end&columns')`
  for each VIN (primary + compare). Maps rows → `{ x: Date, values: Record<col,number> }`.
- Open one WebSocket to the **primary** VIN's live endpoint; append incoming points
  (dedup by timestamp) to the in-memory series. (Compare VINs are historical-only —
  see §6 assumptions.)
- Returns `{ series, loading, error, refetch }`.

**`components/telemetry-chart/TelemetryChart.tsx`** — controlled component:
- Props: `vehicleId`, `series` (from the hook), `controls` state, `theme` colors.
- Register `TimeScale` + `chartjs-plugin-zoom` (in addition to existing scales).
- **X axis = time** (`type: 'time'`, `chartjs-adapter-date-fns`) so ranges + zoom align.
- **Series toggle:** maintain `hiddenSeries: Set<string>`; datasets get `hidden: true`.
- **Type switch:** line / area (`fill: true`) / bar.
- **Zoom/pan:** `chartjs-plugin-zoom` (drag + scroll zoom, pan); `interaction: { mode: 'index' }`
  crosshair tooltip; **reset-zoom** `Button`.
- **Dual Y-axis:** auto-split in `lib/telemetry-chart-utils.ts`:
  - Compute median magnitude (e.g. median of per-series max-abs) across series.
  - Series whose values are predominantly within ~[0,100] **and** another series has
    substantially larger magnitude (>5× median) → right axis (`y1`); others → left (`y`).
  - `Single/Dual` `Switch` overrides (Single = all on `y`).
- **Compare:** each VIN gets a distinct color family; legend groups by VIN.

**`components/chart-controls.tsx`** — shadcn controls bound to the above state:
`Select` (line/area/bar), legend-click toggle, `Switch` (single/dual axis),
`Button` (reset zoom), `Dialog` (compare-VIN picker; suggestions from `/api/devices`).

**`hooks/use-chart-theme.ts`** — reads `next-themes` `resolvedTheme`; returns
grid/axis/legend/text colors so the canvas matches light/dark and updates on toggle.

### 3.5 Fleet & auth polish
- **`app/fleet/page.tsx`** — shadcn `Table`/`Card`; loading/empty states; status `Badge`
  (last-seen); row-click navigation; dark-ready.
- **`app/auth/signin/page.tsx`** — centered `Card`, consistent with shell.
- **`components/data-table.tsx`**, **`time-range-selector.tsx`**, **`gps-track-map.tsx`**,
  **`ScoringAlerts.tsx`** — dark-mode tokens + minor polish.

### 3.6 Error handling
- Fetch/WS failures surface via `sonner` toast **and** the `StateView` error Card with
  retry (`refetch`). Chart degrades gracefully: if live drops, historical stays;
  if API errors, show error state (do not crash the page).

## 4. Data Flow

```
range / vin / compareVins
        │
        ▼
useTelemetryData ──fetch──▶ /api/telemetry/[vin]?start&end&columns  (historical)
        │
        ├─▶ builds series[] (x:Date, values)
        │
        └─▶ WebSocket(primary vin) ──append live points──▶ series[] (real-time)
                        │
                        ▼
              TelemetryChart (time x-axis, toggles, zoom, dual-axis, compare)
                        │
                        ▼
              ChartControls (user mutates view state only)
```

The time-range selector and the chart now read the **same** range → they agree.

## 5. Testing

- Keep existing `make test` (integration) green — this is a frontend-only change; no
  backend behavior changes.
- Add a **low-cost** check (component/behavior) for the chart controls if it does not
  bloat the suite: e.g. series-toggle hides a dataset, type-switch changes render type.
  No over-testing of Chart.js internals.
- Manual verification in browser: light/dark toggle, empty/error/loading states,
  historical+live agreement, zoom/reset, dual-axis, compare.

## 6. Assumptions & Out of Scope

- **Out of scope (explicitly not selected):** export to PNG/CSV, threshold/alert lines.
- **Assumption:** Compare mode is **historical-only** overlay (one live WS for the
  primary VIN avoids N sockets). Can be extended later.
- **Assumption:** `chartjs-plugin-zoom` drag-zoom is enabled on the time axis only;
  y-axis pan enabled, y-axis zoom disabled by default to avoid accidental squish.
- **Assumption:** shadcn `init` in Tailwind v4 mode succeeds against the current
  Next 16 / React 19 setup; if the CLI has friction, fall back to manually adding the
  `components/ui/*` primitives + `lib/utils.ts` + CSS variables (same end state).

## 7. Acceptance Criteria

1. App has working light/dark theme toggle, persists across reloads, respects system on first load.
2. Device page shows consistent layout with loading / empty / error states for chart and table.
3. Chart reflects the selected time-range **and** streams live updates (time selector + chart agree).
4. User can toggle series, switch line/area/bar, zoom/pan + reset, and toggle single/dual axis.
5. Compare mode overlays ≥2 VINs historically with distinct colors.
6. Fleet and auth pages are visually consistent with the new shell and theme.
7. `make test` remains green; no regressions in existing flows.

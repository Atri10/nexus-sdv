# Nexus Command Deck — Immersive UI Design & Spec

- Date: 2026-08-05
- Branch: `feat/local-dev-no-gcp`
- Status: design approved → implementation plan

## 1. Goal

Transform the data-web-client into an immersive "command deck" for the
connected-fleet platform: procedural 3D scenes (react-three-fiber) for the
fleet map, the per-vehicle component model, and the demo data pipeline —
wrapped in a neon HUD design system (Orbitron + JetBrains Mono, deep-space
dark, emerald/cyan glow, glass panels, starfield/grid). **All data remains in
accessible 2D charts + tables**; 3D is the immersive layer only. Charts
themselves get a detailed upgrade (HUD theming, unit-aware axes, sparklines,
deltas, crosshair, decimation).

## 2. Decisions (user-approved)

1. **Neon command deck** — dark-only immersive styling (#020617, cyan primary,
   emerald live, Orbitron display + JetBrains Mono data, glass panels, glow).
2. **Procedural 3D** — three.js + @react-three/fiber + @react-three/drei,
   styled primitives (no external assets), lazy-loaded per page.
3. **Full scope** — fleet + device + demo in one pass.
4. **Graphs in detail** — charts get HUD theming + real functional upgrades
   (unit-aware axes, sparklines in KPI cards, delta indicators, crosshair,
   decimation), not just recoloring.

## 3. Design

### 3.1 Design tokens & global layer

- `globals.css` (Tailwind v4 `@theme inline`): background `#020617`,
  foreground `#F8FAFC`, primary cyan `#22D3EE`, accent emerald `#22C55E`,
  compare-vin violet `#8B5CF6`, muted `#1A1E2F`, border `#1E293B`,
  destructive `#EF4444`; radius + spacing tokens unchanged.
- Fonts via next/font: `Orbitron` (700/900, display + headings + KPI values)
  and `JetBrains Mono` (400/500/700, data + body). Replace the Geist pair in
  the app shell. Canvas charts get the mono family via
  `document.fonts.ready` + `getComputedStyle` fallback (utility in the chart
  theme hook).
- Background layers (fixed, `-z-10`): CSS starfield (multiple radial-gradient
  dot layers + slow drift keyframes) + perspective floor grid (linear-gradient
  lines with `transform: perspective`), both disabled under
  `prefers-reduced-motion`.
- Utilities: `.hud-panel` (glass: backdrop-blur + 1px border + glow shadow),
  `.glow-cyan`, `.glow-emerald` (box-shadow), `.hud-scan` (rare scanline
  sweep), existing `live-ping` kept.
- `AppLayout` + `sidebar` reskin: Orbitron "NEXUS SDV" logo with glow,
  glass nav with glowing active states, HUD header strip.
- Dark-only for the deck: keep `next-themes` toggle (device pages unaffected
  functionally), but the deck surfaces are styled dark-first; the toggle stays
  available (existing light theme still renders, deck panels remain readable).

### 3.2 3D foundation (`src/components/scene/`)

- `SceneCanvas` wrapper: WebGL support detection (`webgl` context probe) →
  renders children or a `fallback` prop; `dpr={[1, 1.75]}`; `frameloop`
  "always" for live scenes; `prefers-reduced-motion` → particle/auto-rotate
  disabled (matchMedia listener); `role="img"` + `aria-label`.
- `GridFloor`: wireframe grid (gridHelper-style primitives or shader-free
  line grid) with faint fog; `Starfield`: drei `Stars`-like custom points or
  drei Stars (drei is a dependency — use `Stars`).
- `VehicleModel`: procedural low-poly car — body box, cabin box, 4 wheel
  cylinders, emissive underglow plane, headlight cones; accepts `color` +
  `emissive` props (per-VIN from the existing `vinColorFamily` palette);
  optional `pulse` (live indicator ring).
- `useSceneTheme`: resolves scene colors from CSS custom properties once
  (scene is dark-only — static defaults suffice).
- Shared interaction: pointer-events per threejs guidance (raycast → cursor
  pointer on hover; touch supported via R3F pointer events), `onSelect`
  callbacks.

### 3.3 Fleet page (`/fleet`)

- `FleetScene` fills the page hero: vehicles positioned by **live GPS
  coordinates** (lat/lng → x/z projection around origin; fallback positions
  for vehicles without GPS), each with pulse ring while "live" (recent
  telemetry). drei `OrbitControls` (damping, FOV 50, min/max distance).
- Click vehicle (3D) or table row → `/device/<vin>`.
- Existing search + device table remain below (accessible path, sorting,
  pagination); a slim fleet summary strip (count, live count, selected VIN).
- No vehicles yet → StateView empty state over the scene.

### 3.4 Device page (`/device/[id]`)

- `DeviceScene`: a VehicleModel with **4 glowing component zones**
  (wireframe/emissive boxes: battery underfloor, powertrain front, chassis
  center, cabin rear) — click a zone → chart filters to that component's
  columns; active zone pulses; cursor feedback.
- Zone→columns metadata: **promote** `demo/vehicle-components` →
  `src/lib/vehicle-components.ts` (shared by device + demo pages; the demo
  page's existing exports re-import from there — no duplicate definitions).
- Existing chart (HUD-styled), KPI strip (with sparklines + deltas), GPS
  track map, data table, time-range selector, controls all remain.

### 3.5 Demo page (`/demo`)

- Replace the SVG schematic + data path with 3D: `DemoScene` containing the
  VehicleModel with zones (click → componentId, same behavior as today) and
  `DemoPipeline` — 5 glowing nodes (Component, NATS, Connector, Bigtable,
  Chart service, Graph) connected by curved tubes; **particle streams flow
  along the path while telemetry runs**; the selected sensor's hop
  highlights. Control bar, status badge, chart + KPI strip unchanged.
- The existing SVG schematic/data-path components become the WebGL-off /
  reduced-motion fallback (keep files, render conditionally).

### 3.6 Chart detail track (the "graphs in detail" ask)

- `useChartTheme` extended: JetBrains Mono ticks (resolved via
  `document.fonts.ready`), HUD grid (faint lines, brighter zero line), glow
  underlay for line datasets (wider translucent stroke beneath the 2px line —
  no canvas shadowBlur), area gradients (existing) + bar glow accent, HUD
  tooltip (dark glass, mono values, unit suffixes), crosshair line on hover
  (custom plugin, ~40 lines), `maxTicksLimit` + time-axis label formatting
  (HH:mm:ss within a day, date+time beyond).
- Decimation: register chart.js `decimation` plugin with `enabled: true,
  algorithm: 'lttb', threshold: 400` for line/area datasets (keeps 1000-point
  fetches smooth) — verify zoom/pan interplay.
- Unit-aware axes: axis titles carry units from component metadata
  (`Power (kW)`, `Velocity (km/h)`, …) via the shared metadata; right-axis
  title already derived from the actual right series (keep).
- KPI strip upgrade (`LatestStats` + `latestValues`): **sparklines** (tiny
  inline SVG of the last N points per series) + **delta indicators** (▲/▼
  vs the previous value, emerald/red, mono) + units from metadata. Deltas/
  sparklines need last-two-points access → extend `latestValues` with
  `previous` + `history` (last ~20 points) fields; pure helpers + tests.
- GPS map stays 2D (the existing track map) — no 3D for spatial data per
  chart-guidance (a11y).

### 3.7 Motion

- framer-motion: page container entrances (fade+rise, 150–300ms, staggered
  children), card reveals, KPI value "count-up" on mount, elastic hover on
  interactive cards/chips (CSS `transition` + `hover:scale-[1.02]` — the
  design-system preset approximated without GSAP; framer for layout-aware
  bits). `useReducedMotion` respected (entrances become opacity-only).

### 3.8 Accessibility & performance

- WebGL fallback: scenes render their 2D fallback (fleet table, SVG schematic,
  SVG data path) when WebGL is unavailable; scenes carry `role="img"` +
  labels; all interactions have keyboard paths (table rows, zone chips).
- `prefers-reduced-motion`: no particle flow, no auto-rotate, no drift,
  no count-up.
- Performance: three chunks lazy + `ssr:false`; `dpr` capped; particle counts
  modest (<2k); charts: decimation + existing 1500-point cap; three + drei +
  framer add ~180KB gzip to the three lazy chunks only (app shell unchanged).

## 4. Files

- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `src/components/app-layout.tsx`,
  `src/components/sidebar.tsx`, `src/hooks/use-chart-theme.ts`,
  `src/lib/telemetry-chart-utils.ts` (sparkline/delta helpers),
  `src/lib/telemetry-table.ts` (latestValues extension),
  `src/components/latest-stats.tsx` (sparklines + deltas),
  `src/components/telemetry-chart/TelemetryChart.tsx` (HUD + decimation +
  crosshair), `src/lib/register-chart.ts`, `src/app/fleet/page.tsx`,
  `src/app/device/[id]/page.tsx`, `src/app/demo/page.tsx`,
  `src/components/demo/*` (fallback wiring), `package.json` + `bun.lock`
- Create: `src/components/scene/{scene-canvas,grid-floor,starfield,vehicle-model}.tsx`,
  `src/components/scene/{fleet-scene,device-scene,demo-pipeline}.tsx`,
  `src/lib/vehicle-components.ts` (promoted), tests for pure logic
  (`scene-coords`, `latestValues` extension, fallback detection)
- Docs: README + ARCHITECTURE short "Command Deck" paragraph
- Deps (bun add): `three`, `@react-three/fiber`, `@react-three/drei`,
  `framer-motion`; dev: `@types/three`

## 5. Acceptance criteria

- `/fleet` shows the 3D scene with vehicles at GPS positions, click → device;
  search + table fully functional beneath.
- `/device/<vin>`: 3D vehicle with clickable zones filtering the chart;
  charts HUD-styled with unit-aware axes, crosshair, decimation; KPI cards
  with sparklines + deltas; table/GPS/controls unchanged.
- `/demo`: 3D vehicle + holographic pipeline with flowing particles while
  running; control bar + discovery + chart intact; WebGL-off → SVG fallback.
- Reduced-motion + keyboard paths verified; no new lint problems; full suite
  (108+) + build green; lazy chunks verified in the build output.

## 6. Out of scope

- Light-theme immersion (deck is dark-first; existing light theme still
  renders).
- External 3D model assets; 3D charts (a11y-grade D — explicitly avoided);
- GCP-side or backend changes; performance beyond the caps above.

## 7. Risks

- R3F v9 + React 19 peer compatibility (drei pulls) — verify at `bun add`;
  pin if needed.
- Canvas + webfonts: ticks may render with the fallback font until
  `document.fonts.ready` resolves — handled in the theme hook.
- Chart.js decimation + zoom plugin interplay (decimated data + zoom) —
  verify visually; disable decimation below a point-count threshold.
- Bundle size on low-end devices: dpr cap + lazy chunks + modest particles;
  document a `?plain=1` escape hatch? (No — the fallbacks suffice.)

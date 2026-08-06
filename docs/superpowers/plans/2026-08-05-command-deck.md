# Nexus Command Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Immersive HUD redesign of the web client — procedural 3D fleet/device/demo scenes (react-three-fiber) in a neon command-deck design system, with a detailed chart upgrade (HUD theming, unit axes, crosshair, decimation, KPI sparklines + deltas). All data stays in accessible 2D; 3D is the immersive layer.

**Architecture:** Design tokens + fonts in the global layer; a shared `src/components/scene/` 3D foundation (WebGL detection, reduced-motion, primitives) consumed by three page scenes; chart upgrades in the theme hook + TelemetryChart + LatestStats; motion via framer-motion.

**Tech Stack:** Next.js 16, React 19, bun, Tailwind v4, shadcn/ui, Chart.js, three + @react-three/fiber + @react-three/drei + framer-motion (new), next/font (Orbitron, JetBrains Mono).

## Global Constraints

- Branch: `feat/local-dev-no-gcp` only. Never touch `main`/`origin/main`.
- bun only (never npm); `bun.lock` committed. New deps: `three`, `@react-three/fiber`, `@react-three/drei`, `framer-motion`; dev: `@types/three`. Verify R3F v9 peer compatibility with React 19 at install (pin if needed).
- 3D never carries data (chart-guidance a11y D): every 3D surface keeps its 2D twin; scenes are `ssr:false` lazy chunks; WebGL-off → 2D fallback; `prefers-reduced-motion` disables particle flow/auto-rotate/drift.
- No external 3D assets; procedural primitives only.
- Existing functionality must not regress: fleet search/table, device chart/table/GPS/controls, demo control bar + discovery; the 108-test suite + build + lint (no new problems) stay green.
- Dark-first deck: `next-themes` toggle stays, but deck surfaces are dark-styled; scene colors are static dark defaults.
- Files overlap across tasks (globals.css in T1/T6/T8, register-chart in T2/T6, page files in T3/T4/T5/T8) — execute tasks in order; do not merge/rebase between tasks.

---

### Task 1: Design tokens, fonts, background, shell reskin

**Files:**
- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `src/components/app-layout.tsx`, `src/components/sidebar.tsx`

**Interfaces:**
- Produces: `--font-orbitron`, `--font-jb-mono` CSS vars; `.hud-panel`, `.glow-cyan`, `.glow-emerald`, `.hud-scan` utilities; starfield + grid background layers (reduced-motion-safe); HUD sidebar/layout. Consumed by T2 (scene colors) and T6 (chart fonts).

- [ ] **Step 1: Fonts in layout.tsx**

Add `next/font/google` imports: `Orbitron` (weights 700, 900, variable) + `JetBrains_Mono` (weights 400, 500, 700, subsets latin). Replace the Geist vars in the `<html>` className: `--font-geist-sans` → `--font-orbitron` (display) and keep a body/data var `--font-jb-mono`; set the body font to JetBrains Mono by default (HUD data look), headings use Orbitron. Update `src/app/globals.css` `html { @apply font-sans }` → `font-mono` equivalents (keep Tailwind's `font-sans`/`font-mono` mapped to the new vars via `@theme inline`).

- [ ] **Step 2: Tokens in globals.css**

In the `:root` / `.dark` blocks of `globals.css`, override the shadcn tokens to the deck palette:
- `--background: oklch(0.145 0.02 260)` ≈ #020617; `--foreground: oklch(0.98 0 0)` ≈ #F8FAFC
- `--primary: oklch(0.80 0.13 210)` ≈ cyan #22D3EE; `--accent: oklch(0.78 0.20 150)` ≈ emerald #22C55E (use for positive/selected); keep `--ring` cyan-ish
- `--muted: oklch(0.19 0.02 260)` ≈ #1A1E2F; `--border: oklch(0.28 0.03 260)` ≈ #1E293B; `--card: oklch(0.16 0.02 260)` with transparency handled by the panel utility
- Add `@theme inline` font maps: `--font-display: var(--font-orbitron)`, `--font-mono: var(--font-jb-mono)` and a `font-display` utility class.

- [ ] **Step 3: Utilities + background**

Add to `globals.css`:
```css
/* HUD glass panel */
.hud-panel {
  position: relative;
  border: 1px solid hsl(from var(--border) h s l / 0.8);
  background: linear-gradient(180deg, hsl(from var(--card) h s l / 0.7), hsl(from var(--card) h s l / 0.4));
  backdrop-filter: blur(12px);
  box-shadow: 0 0 24px hsl(from var(--primary) h s l / 0.06), inset 0 1px 0 hsl(from var(--border) h s l / 0.6);
}
.glow-cyan { box-shadow: 0 0 18px hsl(from var(--primary) h s l / 0.35), 0 0 40px hsl(from var(--primary) h s l / 0.12); }
.glow-emerald { box-shadow: 0 0 18px hsl(from var(--accent) h s l / 0.35), 0 0 40px hsl(from var(--accent) h s l / 0.12); }
```
(Tailwind v4 supports `hsl(from …)` — verify at implementation; if the installed Tailwind version rejects it, use plain `rgba()` values matching the tokens.)

Background layers (a `#deck-backdrop` fixed div rendered in `app-layout.tsx` with `-z-10`):
- starfield: 3 layered `radial-gradient(circle, rgba(255,255,255,0.6) 1px, transparent 1px)` backgrounds with different sizes, animated `background-position` drift (15s/25s/40s linear infinite) — disabled under `prefers-reduced-motion`.
- floor grid: a bottom-half div with `background-image: linear-gradient(rgba(34,211,238,0.12) 1px, transparent 1px), linear-gradient(90deg, …)` + `transform: perspective(500px) rotateX(60deg)` + `transform-origin: top`; subtle cyan grid; no animation.
- a vignette: `radial-gradient(ellipse at center, transparent 55%, rgba(2,6,23,0.8))`.

- [ ] **Step 4: Shell reskin**

`app-layout.tsx`: render `<div id="deck-backdrop" …>` before the sidebar/content; content wrappers get `hud-panel` treatment on cards where appropriate (sidebar panel, header strip). Header: Orbitron "NEXUS SDV" with `glow-cyan` text-shadow utility (add `.glow-text` in css). `sidebar.tsx`: glass nav, active item gets `glow-cyan` + cyan text + left accent bar; keep the scoring box styling coherent. Apply `hud-panel` to the sidebar container.

- [ ] **Step 5: Verify**

Run: `cd sample-clients/data-web-client && bun run build` → green; `bun run lint` → no NEW problems; visual sanity via `bun run dev` + browser (see T9 for full pass): dark background, starfield drift, grid, fonts applied (computed font-family on h1 = Orbitron).

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css src/app/layout.tsx src/components/app-layout.tsx src/components/sidebar.tsx
git commit -m "feat(web): command-deck tokens, Orbitron/JetBrains Mono, starfield backdrop, HUD shell"
```

---

### Task 2: 3D foundation (deps + SceneCanvas + primitives)

**Files:**
- Modify: `package.json`, `bun.lock` (via bun add), `src/lib/register-chart.ts` (no — keep; nothing here)
- Create: `src/components/scene/scene-canvas.tsx`, `src/components/scene/grid-floor.tsx`, `src/components/scene/starfield.tsx`, `src/components/scene/vehicle-model.tsx`, `src/lib/scene-coords.ts` + `src/lib/scene-coords.test.ts`

**Interfaces:**
- Produces: `SceneCanvas({ children, fallback, ariaLabel, animateParticles, className })` (WebGL detect, dpr cap, reduced-motion context via `useReducedMotion`-equivalent); `GridFloor`, `Starfield`, `VehicleModel({ color, emissive, pulse, scale })`; pure `projectLatLng(lat, lng, originLat, originLng, scaleMeters) → {x, z}` + `webglSupported() → boolean` (testable). Consumed by T3–T5.

- [ ] **Step 1: Install deps + peer check**

```bash
cd sample-clients/data-web-client && bun add three @react-three/fiber @react-three/drei framer-motion && bun add -d @types/three
```
Verify: `bun pm ls` shows R3F v9.x (React 19 peer) + three latest. If `bun run build`/typecheck fails on peers, pin compatible versions (record the pins in the report). Do NOT commit yet.

- [ ] **Step 2: scene-coords + webgl detection (TDD)**

`src/lib/scene-coords.ts`:
```ts
export interface ScenePoint { x: number; z: number }

/** Project (lat, lng) to scene x/z. Meters-per-unit ~ 1 unit = 10m. */
export function projectLatLng(
  lat: number, lng: number, originLat: number, originLng: number, metersPerUnit = 10
): ScenePoint {
  const R = 6371000;
  const dLat = (lat - originLat) * (Math.PI / 180);
  const dLng = (lng - originLng) * (Math.PI / 180);
  const x = (dLng * R * Math.cos((originLat * Math.PI) / 180)) / metersPerUnit;
  const z = -(dLat * R) / metersPerUnit; // north = -z (screen up)
  return { x, z };
}

/** True only when a WebGL2/WebGL context can be created. */
export function webglSupported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
```
Test (`scene-coords.test.ts`): same point → 0,0; 1° north → negative z of ≈ 11119/10 units; 1° east at origin → positive x ≈ 11119/10 (use toBeCloseTo with 1% tolerance); webglSupported returns false under `typeof document === 'undefined'` guard and true/false depending on stub `canvas.getContext` (mock the canvas in the test).

- [ ] **Step 3: SceneCanvas**

`scene-canvas.tsx` (client, `'use client'`): props `{ children, fallback?, ariaLabel, animate?: boolean, className? }`. Implementation:
- `const supported = useMemo(webglSupported, [])`; if false → `fallback ?? null`.
- `const reduced = useReducedMotion()` (framer-motion); `animate = animate && !reduced`.
- Render `<Canvas dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: 'high-performance' }} camera={{ fov: 50, position: [0, 6, 10] }} role="img" aria-label={ariaLabel} className={className}>` + `<color attach="background" args={['#020617']} />` + `<fog attach="fog" args={['#020617', 18, 40]} />` + children.
- Wrap children in a context `SceneMotionContext` providing `{ animate }` (particle/auto-rotate consumers read it) — tiny `createContext`.
- Consumers import the component via `dynamic(() => import('@/components/scene/scene-canvas'), { ssr: false })` — provide a small `src/components/scene/scene-canvas-dynamic.tsx` exporting the dynamic wrapper + a `SceneFallback` type, so pages don't repeat the dynamic-import boilerplate.

- [ ] **Step 4: Primitives**

- `grid-floor.tsx`: `<gridHelper args={[40, 40, '#0f2740', '#123047']} position={[0, -0.05, 0]} />` (three gridHelper via R3F `<gridHelper>` is not a primitive — use `<gridHelper args>` JSX intrinsic; verify) or a custom `<lineSegments>` grid; plus a translucent circular pad under the origin.
- `starfield.tsx`: drei `<Stars radius={60} depth={40} count={1500} factor={3} fade speed={0.4} />` — disable `speed` (set 0) when `!animate`.
- `vehicle-model.tsx`: procedural car:
  - body: `<mesh position={[0, 0.5, 0]}><boxGeometry args={[1.6, 0.5, 3.2]} /><meshStandardMaterial color={color} metalness={0.6} roughness={0.3} /></mesh>`
  - cabin: smaller box on top with dark glass material (`#0b1220`, metalness 0.9, roughness 0.1)
  - wheels: 4 `<mesh>` cylinders rotated on their sides (radius 0.28, width 0.2) at the corners, dark material
  - underglow: `<mesh position={[0, 0.03, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[1.7, 3.3]} /><meshBasicMaterial color={emissive} transparent opacity={0.35} /></mesh>`
  - headlights: two small emissive boxes at the front
  - `pulse` prop: a `useFrame`-driven ring (torus or ringGeometry) scaling/opacity oscillating when live && animate; when `!animate`, static ring.
  - Accepts `scale` (default 1) — applied via `<group scale={scale}>`.

- [ ] **Step 5: Verify**

Run: `cd sample-clients/data-web-client && bun run test` (new coords/webgl tests green), `bun run build` green, `bun run lint` no new.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/lib/scene-coords.ts src/lib/scene-coords.test.ts src/components/scene
git commit -m "feat(web): 3D foundation — SceneCanvas (WebGL detect, reduced-motion, dpr), primitives, scene-coords"
```

---

### Task 3: Fleet 3D scene + page

**Files:**
- Create: `src/components/scene/fleet-scene.tsx`
- Modify: `src/app/fleet/page.tsx`

**Interfaces:**
- Consumes: T1 tokens, T2 SceneCanvas/VehicleModel/GridFloor/Starfield/projectLatLng.
- Produces: `FleetScene({ vehicles, liveVins, onSelect })` where `vehicles: { vin, lat?, lng? }[]`; page shows the scene in a `hud-panel` hero + existing search/table below; click vehicle or row → `/device/<vin>`.

- [ ] **Step 1: FleetScene**

- Dynamic import SceneCanvas + drei `OrbitControls` (`enableDamping`, `dampingFactor={0.08}`, `minDistance={4}`, `maxDistance={30}`, `target={[0,0,0]}`; `autoRotate={animate} autoRotateSpeed={0.4}` when `animate`).
- Vehicles: `vehicles.map(v => <group key={v.vin} position={[p.x, 0, p.z]} onClick={() => onSelect(v.vin)} onPointerOver={...cursor pointer} onPointerOut={...}> <VehicleModel color={colorFor(v.vin)} emissive={liveVins.has(v.vin) ? '#22C55E' : '#0e7490'} pulse={liveVins.has(v.vin) && animate} /> </group>)` where `colorFor` reuses the existing `vinColorFamily` palette from `telemetry-chart-utils` (export it if needed) — vehicles without GPS get deterministic scattered positions (`hash(vin) % ring`).
- Live detection is the page's job: `liveVins` = VINs with a row newer than ~2×interval (page can approximate via `useTelemetryData`-style fetch or the devices route — simplest: the page passes `liveVins` from the demo-control `status`-style probes? Keep it cheap: page passes an empty set initially and the scene renders without pulses; the fleet page can use the chart-service `listVehicles` + latest timestamps if cheap — for this task, accept a `liveVins` prop defaulting to empty and wire real data in T9 polish if time permits; document).
- Vehicle labels: drei `<Html distanceFactor={8} center>` with a mono VIN tag (only when `vehicles.length <= 12` to avoid clutter) or `<Billboard>`; use `Html` with `pointerEvents: 'none'` styling.
- Clicking empty space: deselect (clear highlight) — track `selected` in the page.

- [ ] **Step 2: Page integration**

`src/app/fleet/page.tsx`:
- Fetch devices (existing route/lib) → `vehicles`; keep the existing search + table + pagination.
- Scene hero above the table: `<FleetScene vehicles={vehicles} liveVins={liveVins} onSelect={(vin) => router.push(`/device/${vin}`)} />` inside a `hud-panel` with the "Fleet" Orbitron heading.
- Fleet summary strip: 3 mono stat chips (vehicles count, live count, selected VIN) — small, no new lib.
- Empty state: when `vehicles.length === 0`, render StateView over the scene area.
- WebGL-off: SceneCanvas fallback → render the table only (scene area hidden) or a simple "3D view unavailable — using table" note; the table is the accessible path anyway.

- [ ] **Step 3: Verify**

`bun run test` green, `bun run build` green, lint no new; browser smoke (stack is up): `/fleet` shows the scene with vehicles positioned; click a vehicle → device page.

- [ ] **Step 4: Commit**

```bash
git add src/components/scene/fleet-scene.tsx src/app/fleet/page.tsx
git commit -m "feat(web): 3D fleet scene — vehicles at GPS positions, click-to-dive, HUD hero"
```

---

### Task 4: Device 3D scene + component zones

**Files:**
- Create: `src/lib/vehicle-components.ts` (promoted from `src/lib/demo/vehicle-components.ts`), `src/components/scene/device-scene.tsx`
- Modify: `src/app/device/[id]/page.tsx`, `src/app/demo/page.tsx` + `src/components/demo/vehicle-schematic.tsx` (re-import from the promoted lib — keep file paths working via re-export)

**Interfaces:**
- Produces: shared `DEMO_COMPONENTS` (renamed usage stays), `seriesForComponent`, `latestValuesFor`, plus new `COMPONENT_ZONES: { id, label, position: [x,y,z], size: [w,h,d], color }[]` (zone geometry for the 3D scene); `DeviceScene({ componentId, onSelect, color, animate, series })`. Consumed by T5 (demo scene) and T6 (unit-aware axes).

- [ ] **Step 1: Promote the metadata lib**

Move `src/lib/demo/vehicle-components.ts` → `src/lib/vehicle-components.ts`; keep `src/lib/demo/vehicle-components.ts` as a re-export (`export * from '@/lib/vehicle-components'`) so `/demo` imports keep working; update the demo page import to the new path (clean cutover: update the page + delete the shim? Keep the shim ONLY if other files import it — grep; prefer deleting the shim and updating importers). Add to the lib:
```ts
export interface ComponentZone {
  id: string; label: string;
  position: [number, number, number];
  size: [number, number, number];
  color: string; // cyan-ish emissive
}
export const COMPONENT_ZONES: ComponentZone[] = [
  { id: 'battery',    label: 'Battery',    position: [0, 0.25, 1.0], size: [1.2, 0.35, 0.9], color: '#22D3EE' },
  { id: 'powertrain', label: 'Powertrain', position: [0, 0.35, -0.9], size: [0.9, 0.4, 0.7], color: '#22C55E' },
  { id: 'chassis',    label: 'Chassis',    position: [0, 0.1, 0],    size: [1.5, 0.2, 2.6], color: '#8B5CF6' },
  { id: 'cabin',      label: 'Cabin',      position: [0, 0.9, -0.2], size: [1.0, 0.55, 1.2], color: '#F59E0B' },
];
```
Test: zones reference only known component ids (cross-check `DEMO_COMPONENTS`); every sensor qualifier in `DEMO_COMPONENTS` appears in the connector contract list (existing test — extend to import from the new path).

- [ ] **Step 2: DeviceScene**

- VehicleModel at origin (scale 1.6) + 4 zone boxes: `<mesh position={z.position}><boxGeometry args={z.size} /><meshBasicMaterial color={z.color} transparent opacity={active ? 0.35 : 0.12} /></mesh>` + an emissive wireframe `<lineSegments>` (EdgesGeometry from the same box) with `opacity`/glow boost when active.
- Zone interaction: `onClick={() => onSelect(z.id)}`, pointer cursor feedback; active zone pulses via `useFrame` (scale oscillation 1→1.06) when `animate`.
- Camera: OrbitControls (FOV 50, min 3, max 12, target [0, 0.5, 0]), autoRotate when `animate` and nothing selected? Keep autoRotate off (selection-driven) — static camera with damping.
- Keyboard path note: zones are also available as chips in the page (existing pattern) — the scene is a visualization of the same state.

- [ ] **Step 3: Page integration**

`src/app/device/[id]/page.tsx`:
- Add the scene in a `hud-panel` above the chart: `<DeviceScene componentId={componentId} onSelect={setComponentId} color={theme-primary} animate />` (dynamic import + WebGL fallback → render nothing (chart remains)).
- Zone chips row under the scene (4 buttons, active glow) — the keyboard/accessible selector (aria-pressed + focus rings).
- Chart filter: `seriesForComponent(series, componentId)` (already the pattern on /demo — port to the device page: currently the device page charts ALL columns; changing the default behavior could surprise — **scope decision**: the device page gains a "Component" filter control (chips) that defaults to "All" (no filter), plus zone clicks set it. So `componentId: string | 'all'`; when not 'all', filter series via `seriesForComponent`.)

- [ ] **Step 4: Verify**

`bun run test` green (updated metadata tests), build green, lint clean; browser: `/device/VIN1005` shows the model + zones; clicking a zone filters the chart to that component; chips mirror the selection.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vehicle-components.ts src/lib/demo/vehicle-components.ts src/components/scene/device-scene.tsx src/app/device/[id]/page.tsx src/app/demo/page.tsx
git commit -m "feat(web): 3D device scene with component zones filtering the chart; shared component metadata"
```

---

### Task 5: Demo 3D holographic pipeline

**Files:**
- Create: `src/components/scene/demo-pipeline.tsx`, `src/components/scene/demo-scene.tsx`
- Modify: `src/app/demo/page.tsx`

**Interfaces:**
- Consumes: T2 primitives, T4 zones/metadata, demo page state (componentId, status.running).
- Produces: `DemoScene({ componentId, onSelect, flowing, animate, vin })` — vehicle with zones + the holographic pipeline; SVG fallback components (`vehicle-schematic`, `data-path`) remain and render when WebGL is off or reduced-motion (visual fallback).

- [ ] **Step 1: DemoPipeline**

Nodes (in world space, a curved arc layout): Component `[0, 1.2, -4]`, NATS `[-3.5, 1.6, -2]`, Connector `[0, 2.0, 0]`, Bigtable `[3.5, 1.6, 2]`, Chart service `[0, 1.2, 4]`. Each node: emissive box + `Html` label (mono, small). Connections: `QuadraticBezierCurve3` between nodes → `<tubeGeometry>` (radius 0.03, 24 segments) with basic material (cyan, opacity 0.5); the segment for the selected sensor's hop gets a brighter material.
- Particles: an instanced mesh (sphere, 600 instances) or drei `<Trail>`-based streams — simplest robust: one `<points>` per segment with positions computed by sampling the curve with a phase offset (`useFrame` advances `t = (t + dt * speed) % 1`; `animate` gates the advance; when `!animate`, particles sit at t=0.5). Colors: cyan particles; the active segment's particles emerald.
- `flowing` prop: particles only move when `flowing && animate` (flowing = telemetry running); when idle, particles static + nodes dimmed.

- [ ] **Step 2: DemoScene**

Compose: Starfield + GridFloor + VehicleModel (left of the pipeline at `[-4.5, 0, 1.5]`, scale 1.8) with zone boxes (reuse COMPONENT_ZONES, clicking selects the componentId) + DemoPipeline (right half) + OrbitControls (target `[0, 1, 0]`).

- [ ] **Step 3: Page integration**

`src/app/demo/page.tsx`: replace the `VehicleSchematic` + `DataPath` block with:
```tsx
<DemoScene
  componentId={componentId}
  onSelect={setComponentId}
  flowing={status?.running ?? false}
  animate={!reducedMotion}
  vin={vin}
  fallback={<><VehicleSchematic … /><DataPath flowing={…} /></>}
/>
```
where `fallback` is rendered by SceneCanvas when WebGL is unsupported (keep both SVG components + their imports; they are the a11y/reduced-motion path — under reduced-motion render the SVG fallback INSTEAD of the 3D scene via the page-level `useReducedMotion`).

- [ ] **Step 4: Verify**

`bun run test` + build + lint green; browser: `/demo` with telemetry running → particles flow along the path; component zone click selects; reduced-motion emulation → static scene or SVG fallback; WebGL-off (simulate via stub? verify the fallback prop renders — unit-test `webglSupported` already covers the detection; visually test by temporarily forcing `webglSupported() === false` in dev).

- [ ] **Step 5: Commit**

```bash
git add src/components/scene/demo-pipeline.tsx src/components/scene/demo-scene.tsx src/app/demo/page.tsx
git commit -m "feat(web): 3D holographic demo pipeline with flowing particles; SVG fallbacks retained"
```

---

### Task 6: Chart detail track — HUD theming, crosshair, decimation, unit axes

**Files:**
- Modify: `src/hooks/use-chart-theme.ts`, `src/lib/register-chart.ts`, `src/components/telemetry-chart/TelemetryChart.tsx`, `src/lib/vehicle-components.ts` (unit fields — already present), `src/lib/telemetry-chart-utils.ts` (unit lookup helper)

**Interfaces:**
- Produces: HUD chart theme (mono ticks resolved from loaded fonts, glow underlay, crosshair, decimation, unit-aware axis titles + tooltip suffixes). Consumed by all chart surfaces (device, demo).

- [ ] **Step 1: Font resolution + theme extension**

In `use-chart-theme.ts`: add `fontFamily` (resolved once: `document.fonts?.ready.then(() => getComputedStyle(document.body).fontFamily)` cached in a module var, fallback `'JetBrains Mono, monospace'`), and extend the returned theme: `{ grid, ticks, title, fontFamily, crosshair: '#22D3EE' }`. All chart option consumers use `theme.fontFamily` in `scales.*.ticks.font`, `plugins.title.font`, tooltip `titleFont/bodyFont` (Chart.js v4 `font: { family }`).

- [ ] **Step 2: Crosshair plugin**

Add `src/lib/crosshair.ts` (pure, testable-ish): a Chart.js plugin (~50 lines):
- `id: 'hudCrosshair'`; `afterDatasetsDraw(chart)`: on `hover` active element, draw a vertical line across the chart area (`ctx.strokeStyle` from `chart.options.plugins.hudCrosshair.color`, `lineWidth: 1`, `setLineDash([4,4])`) + a faint horizontal line at the hovered y; clear when no active element.
- Register in `register-chart.ts`. Option toggle `plugins.hudCrosshair: { color: theme.crosshair }` in TelemetryChart options.

- [ ] **Step 3: Decimation**

In `register-chart.ts`: register the chart.js `decimation` plugin (built into chart.js — `import { Decimation } from 'chart.js'`). In TelemetryChart dataset options: `decimation: { enabled: true, algorithm: 'lttb', threshold: 400, sampleSize: 100 }` for `line`/`area` datasets only (not bar); `animation: { duration: 200 }` stays; verify zoom+decimation coexistence (chart.js docs: decimation applies at render — with zoom, disable decimation while zoomed? Chart.js decimation works on the full dataset; acceptable for the demo; verify visually and note).

- [ ] **Step 4: Unit-aware axes + tooltip**

- `vehicle-components.ts`: sensors already carry `unit` — add `unitForQualifier(qualifier: string): string | undefined` helper (pure + test).
- TelemetryChart: left axis title = "Value" unless all series share a unit (then `Unit`); right axis title already derived from the first right series label — append its unit: `Power (kW)`; y-ticks keep `formatValue`; tooltip label callback appends the unit when the dataset's series has one (pass units via a `units: Record<string,string>` map on the chart props — device/demo pages build it from the component metadata; default {}).
- Time axis: `time: { tooltipFormat: 'HH:mm:ss' }` + ticks callback: within-day → `HH:mm`, cross-day → `MMM d HH:mm` (via `chartjs-adapter-date-fns`? NO new deps — use the existing adapter's `time.displayFormats` config: set `millisecond/second/minute/hour` formats + a custom ticks callback using `Intl.DateTimeFormat` — no new dependency).

- [ ] **Step 5: HUD line styling**

In TelemetryChart dataset factory: for `line`/`area`, add an underlay dataset? Simpler: keep single dataset but `borderWidth: 2` + a `backgroundColor` glow via a second dataset clone with `borderColor: color + '40'`, `borderWidth: 6`, `pointRadius: 0`, `fill: false`, `borderCapStyle: 'round'`? That doubles datasets and confuses tooltips/legend — instead apply the glow via `ctx.shadowColor` ONLY on the line draw (small scriptable `borderColor` won't do shadows). Decision: skip shadow/underlay (perf + complexity); the HUD look comes from grid/tooltip/fonts/crosshair + existing gradients. Note this as a deliberate simplification.

- [ ] **Step 6: Verify**

`bun run test` (new unit helper tests), build, lint; browser: chart shows mono ticks, crosshair on hover, unit suffixes in tooltips + axis titles, smooth 1000-point pan with decimation.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-chart-theme.ts src/lib/register-chart.ts src/lib/crosshair.ts src/components/telemetry-chart/TelemetryChart.tsx src/lib/vehicle-components.ts src/lib/telemetry-chart-utils.ts
git commit -m "feat(web): HUD charts — mono fonts, crosshair, decimation, unit-aware axes and tooltips"
```

---

### Task 7: KPI sparklines + deltas

**Files:**
- Modify: `src/lib/telemetry-table.ts` (+ test), `src/components/latest-stats.tsx`

**Interfaces:**
- Produces: `latestValues` returns `{ …, previous: number | null, history: { x: number; y: number }[] }` (history = last 20 points); `LatestStats` renders a mini SVG sparkline per card + ▲/▼ delta vs previous (emerald/red, mono), units from metadata via `unitForQualifier`.

- [ ] **Step 1: Extend latestValues (TDD)**

Update `latestValues` in `telemetry-table.ts`:
```ts
export interface LatestValue {
  key: string; label: string; color: string;
  value: number | null; timestamp: number | null;
  previous: number | null;
  history: { x: number; y: number }[];
}
```
— during the existing single pass, keep the second-to-last numeric value in `previous` and the last ≤20 points in `history`. Update the existing tests + add: previous tracked correctly across nulls; history capped at 20; no numeric points → previous/history empty.

- [ ] **Step 2: Sparkline SVG**

In `latest-stats.tsx`, under each value: `<svg viewBox="0 0 60 16" className="h-4 w-15" aria-hidden="true">` polyline of `history` normalized (min/max padding 10%), stroke `s.color`, `fill="none" strokeWidth={1.5}`, no animation (or a CSS draw-in when `animate` — keep static; reduced-motion-safe by default).
Delta chip: `value != null && previous != null` → `▲/▼ + (value - previous)` formatted (`formatValue` + 1 decimal), emerald if up (or equal) / red if down, with `aria-label="up from previous"`; when only one point exists → no chip.

- [ ] **Step 3: Verify**

`bun run test` (updated + new tests), build, lint; browser: KPI cards show sparkline + delta on the device and demo pages.

- [ ] **Step 4: Commit**

```bash
git add src/lib/telemetry-table.ts src/lib/telemetry-table.test.ts src/components/latest-stats.tsx
git commit -m "feat(web): KPI sparklines and delta indicators with unit labels"
```

---

### Task 8: Motion polish (framer-motion)

**Files:**
- Create: `src/components/motion/fade-in.tsx` (+ optional `stagger.tsx`)
- Modify: `src/app/fleet/page.tsx`, `src/app/device/[id]/page.tsx`, `src/app/demo/page.tsx`, `src/components/latest-stats.tsx` (value count-up), `src/components/chart-controls.tsx` (elastic hover)

**Interfaces:**
- Produces: `FadeIn` (motion.div: opacity 0→1 + y 8→0, 200ms, once) and `Stagger`/`StaggerItem` (children stagger 60ms); `useReducedMotion` → opacity-only. Applied to page sections (not the 3D canvas itself).

- [ ] **Step 1: Motion primitives**

`fade-in.tsx`: `export function FadeIn({ children, className, delay = 0 }: …) { const reduced = useReducedMotion(); return <motion.div className={className} initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay, ease: 'easeOut' }}>{children}</motion.div>; }`; `stagger.tsx`: `Stagger` (container `initial="hidden" animate="show"` variants staggerChildren 0.06) + `StaggerItem` (fade+rise). Keep them dependency-light; no layout animations.

- [ ] **Step 2: Page application**

- Fleet: `FadeIn` on the scene hero + summary strip; `Stagger` on table sections.
- Device: `FadeIn` on scene panel + chart card + KPI strip.
- Demo: `FadeIn` on control bar + scene panel + chart card.
- KPI count-up: in `LatestStats`, animate the numeric value with a lightweight count-up (`useEffect` + rAF from previous to current over 300ms, respecting reduced motion → direct set). Keep it simple (a small `useCountUp` hook inside latest-stats.tsx).
- Chips/buttons: add `transition-transform duration-200 hover:scale-[1.02]` (Tailwind) + `active:scale-[0.98]` to interactive chips + buttons (chart-controls + device/demo zone chips + control-bar buttons); cursor-pointer already present.

- [ ] **Step 3: Verify**

Build + lint + tests green; browser: entrances subtle, count-up on KPI change, hover scale on chips; emulated reduced-motion → no y-shift/count-up.

- [ ] **Step 4: Commit**

```bash
git add src/components/motion src/app/fleet/page.tsx src/app/device/[id]/page.tsx src/app/demo/page.tsx src/components/latest-stats.tsx src/components/chart-controls.tsx
git commit -m "feat(web): motion polish — staggered entrances, KPI count-up, elastic hovers"
```

---

### Task 9: A11y + performance verification, docs, final pass

**Files:**
- Modify: `local-dev/README.md`, `local-dev/ARCHITECTURE.md` (one paragraph each on the Command Deck)
- Verify-only: full suite, build, lint, bundle check, browser pass (incl. reduced-motion + WebGL-off fallbacks + keyboard), the runtime stack still working (make test equivalent — `make test` if the stack is up, else note).

- [ ] **Step 1: A11y checklist run**

- Keyboard: fleet table rows focusable; device zone chips focusable + aria-pressed; demo controls keyboard-operable; focus-visible rings visible on all new interactive elements (Tailwind `focus-visible:ring-2` on chips/buttons).
- Scenes: `role="img"` + descriptive `aria-label` (e.g. "3D fleet map with N vehicles at their GPS positions"); content behind scenes remains reachable (tables/charts).
- Reduced-motion: starfield drift off, particles static, auto-rotate off, no count-up, entrances opacity-only. Verify via emulation.
- Contrast: mono body at ≥12px on #020617 with #F8FAFC (AA); cyan on dark for interactive elements ≥4.5:1 (cyan #22D3EE on #020617 ≈ 9:1 ✓); emerald text on dark ✓.

- [ ] **Step 2: Performance**

- `bun run build` output: confirm three/drei/framer chunks are lazy (dynamic-import named chunks, not in the main app shell); record main-bundle delta (should be ~0; three lands in `scene-*` chunks).
- dpr cap + particle counts within spec; no `requestAnimationFrame` leaks (scenes unmount cleanly — verify by navigating away/back in the browser; drei OrbitControls dispose on unmount by default — confirm no console errors on route change).

- [ ] **Step 3: Docs**

README "Frontend dashboard" section: add the Command Deck paragraph (3D scenes, HUD theme, WebGL fallbacks, reduced-motion). ARCHITECTURE: one line in the web-client section. No other doc churn.

- [ ] **Step 4: Full verification**

```bash
cd sample-clients/data-web-client && bun run test && bun run lint && bun run build
```
- Report: test count (expect 108+ new tests), lint (no new problems), build green, chunk list.
- Browser final pass: fleet scene → click vehicle → device (zone click filters chart; KPI sparklines move) → /demo (particles flow when running; Start/Stop still work; simulator badge).
- If the stack is up, run `cd local-dev && make test` to confirm no regression in the platform flow; else note it as a follow-up.

- [ ] **Step 5: Commit**

```bash
git add local-dev/README.md local-dev/ARCHITECTURE.md
git commit -m "docs: Command Deck frontend overview"
```
Then final whole-branch review (per subagent-driven-development) + finishing options.

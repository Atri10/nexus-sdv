# Chart System Architecture

## Overview
The chart system provides real-time and historical telemetry visualization for vehicle data. It combines historical API fetches with live WebSocket streams, supporting multiple chart types, dual Y-axes, zoom/pan, and vehicle comparison.

## Core Components

### Data Layer
- **`useTelemetryData`** (`src/hooks/use-telemetry-data.ts`) — Single source of truth
  - Fetches historical data from `/api/telemetry/[vin]?start&end`
  - Opens live WebSocket to `ws://host:8081/api/v1/vehicles/{vin}/telemetry/live` (primary VIN only)
  - Optional `compareVins[]` — historical only (no live sockets to avoid N connections)
  - Returns `{ series: ChartSeries[], loading, error, refetch }`

### Chart Components
- **`TelemetryChart`** (`src/components/telemetry-chart/TelemetryChart.tsx`) — Controlled Chart.js `Line` component
  - Time-scale x-axis (milliseconds since epoch)
  - Chart type: `line` | `area` | `bar` (per-series via `ChartControls`)
  - Dual Y-axis auto-split: series ~0-100 go right when another series >5× median magnitude
  - Zoom: wheel+drag on X only; pan: X+Y; Y-zoom disabled
  - Reset via `resetZoomToken` prop
  - Series toggle via `hidden: Set<string>`

- **`ChartControls`** (`src/components/chart-controls.tsx`) — Toolbar
  - Type select (line/area/bar)
  - Series toggle chips (color dot + label, strikethrough when hidden)
  - Dual-axis switch
  - Reset zoom button
  - Compare VIN input (adds historical overlay)

- **`StateView`** (`src/components/state-view.tsx`) — Loading/Empty/Error/Ready wrapper

### Registration
- **`registerChart()`** (`src/lib/register-chart.ts`) — Idempotent Chart.js registration
  - Registers: `TimeScale`, `LinearScale`, `PointElement`, `LineElement`, `BarElement`, `BarController`, `Tooltip`, `Legend`, `Filler`, `zoomPlugin`
  - Imports `chartjs-adapter-date-fns` for time scale

### Utilities
- **`telemetry-chart-utils.ts`** (`src/lib/telemetry-chart-utils.ts`)
  - `ChartSeries` type
  - `groupAxes(series[])` — dual-axis auto-split logic
  - `formatValue(number)` — 2dp, non-finite → '—'
  - `vinColorFamily(vinIndex, seriesIndex)` — deterministic color palette

- **`useChartTheme()`** (`src/hooks/use-chart-theme.ts`) — Resolves Chart.js colors from `next-themes` (light/dark)

## Data Flow
```
Device Page
  └─ useTelemetryData({ vin, range, compareVins })
       ├─ Historical: GET /api/telemetry/[vin]?start&end
       ├─ Live WS:    ws://host:8081/api/v1/vehicles/{vin}/telemetry/live
       └─ compareVins: historical only (GET per VIN)
            ↓
       series: ChartSeries[]
            ↓
       ChartControls (type, hidden, axisMode, compare) ───→ TelemetryChart
       StateView (loading/empty/error/ready)              ↓
                                                          TelemetryChart
```

## Adding a New Telemetry Column
1. Ensure the column exists in telemetry data (Bigtable → API)
2. No code changes needed — `useTelemetryData` dynamically creates series per column
3. `groupAxes()` auto-detects 0-100 range for dual-axis placement

## Testing
```bash
bun test ./__tests__/lib/telemetry-chart-utils.test.ts   # axis grouping, formatting
bun test ./src/hooks/use-telemetry-data.test.ts          # shapeRows, live append
bun test ./src/lib/register-chart.test.ts                # idempotent registration
```

## Environment
- Chart.js 4.5.1 + react-chartjs-2 5.3.1
- chartjs-plugin-zoom 2.x
- chartjs-adapter-date-fns 3.x
- next-themes for dark mode
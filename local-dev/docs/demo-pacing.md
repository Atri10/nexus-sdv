# Fast-Demo Mode, End to End — how time is accelerated in the local demo

> Audience: engineers working on the nexus-sdv local demo stack. This doc
> traces one control press on the web dashboard all the way to the PM
> detector's health score, and explains exactly **what the fast-demo
> multiplier accelerates — and what it does not**.
>
> Companion docs: [local-dev/ARCHITECTURE.md](../ARCHITECTURE.md) (stack
> wiring + control flow) · [local-dev/README.md](../README.md) (task-oriented
> guide) · [vehicle-client docs/simulator-data-generation.md](../../sample-clients/vehicle-client/docs/simulator-data-generation.md)
> (degradation physics and the tick loop).

## 1. The chain: button press → NATS → simulator tick

Every demo control goes through the same five hops:

```mermaid
sequenceDiagram
    autonumber
    participant WEB as "Next.js /pm + /demo page"
    participant API as "/api/demo/vehicle (Next.js route)"
    participant NATS as "commands.&lt;VIN&gt;.demo"
    participant SIM as "vehicle-simulator controlState.handle()"
    participant LOOP as "simulator tick loop (publishOnce)"

    WEB->>API: "POST {action, vin, preset?, component?}"
    API->>API: "validate action + pool-VIN membership, authz (DEMO_MODE bypass)"
    API->>NATS: "demoControl() nc.request (3 s timeout)"
    NATS->>SIM: "commands.&lt;VIN&gt;.demo JSON request"
    SIM->>SIM: "handle(): adopt VIN (start) / set speed / reset / toggle components"
    SIM-->>WEB: "status reply {vin, running, speed, ground_truth, live, ...}"
    Note over SIM,LOOP: "each tick (INTERVAL=2 s) while running"
    LOOP->>LOOP: "ageDays += dt_days × speed × degradationAccel"
    LOOP->>LOOP: "driveCycleStep(dt, speed): tripDist += v × dt × speed"
    LOOP->>NATS: "telemetry.{VIN} (MetricsReport) + telemetry-generic.{VIN}.{sensor}"
```

Where each hop lives:

| Hop | Code |
|---|---|
| Web page (speed buttons, Start/Stop) | `sample-clients/data-web-client/src/app/pm/page.tsx` (`setSpeed` → `simState.command`), `src/app/demo/page.tsx`; shared write path `src/hooks/use-simulator-state.ts` |
| API route | `sample-clients/data-web-client/src/app/api/demo/vehicle/route.ts` — validates `action ∈ {start, stop, status, speed, reset}`, rejects non-pool VINs, authz via session or `DEMO_MODE=true` |
| NATS publish | `sample-clients/data-web-client/src/lib/demo-control.ts` — `demoControl()` publishes `{"action":..., "vin":...}` JSON to `commands.{VIN}.demo` |
| Simulator handler | `sample-clients/vehicle-client/main.go` — `ensureControlSub` subscribes the `commands.>` **wildcard**; `controlState.handle()` processes each request |
| Tick loop | `sample-clients/vehicle-client/main.go` `publishOnce` — advances battery age + drive cycle, then publishes both protobuf families |

The simulator answers `status` for **every** pool VIN (the `commands.>`
wildcard), so `discoverSimulator` probes the pool in parallel and uses the
reply's own `vin` field — not the probed subject — as the sim's real identity.

## 2. Speed plumbing: DEMO_SPEED → controlState.speed → tick math

There are two entry points into the speed multiplier, and they converge on
one field: `controlState.speed`.

| Entry | Where | Effect |
|---|---|---|
| `DEMO_SPEED` env | `newControlState` (`main.go`) reads it at boot; compose sets `DEMO_SPEED=5` | Initial `controlState.speed` (clamped to ≥ 1) |
| `"speed"` control action | `handle()` (`main.go`) parses the multiplier from the request's **`preset`** field (`{"action":"speed","preset":5}`) | Rewrites `controlState.speed` at runtime |

The web's 1× / 5× / 20× buttons live on the `/pm` page
(`SPEED_OPTIONS = [1, 5, 20]` in `pm/page.tsx`). They are **hardcoded** — the
page does not read `DEMO_SPEED` from its own environment. Pressing a button:

1. `setSpeed(mult)` → `simState.command('speed', String(mult))`;
2. `use-simulator-state` POSTs `{"action":"speed","vin":<simVin>,"preset":"5"}`;
3. the API route forwards it to `demoControl('speed', vin, undefined, '5')`,
   which publishes `{"action":"speed","vin":"VIN1001","preset":"5"}`;
4. `handle()` parses `preset` as the multiplier and sets `c.speed = 5`.

The current multiplier comes back in the **status reply** (`"speed"` field,
from `stateLocked()`), and the page's `aria-pressed` highlight + the
`FAST DEMO · N×` badge read it — so the buttons always reflect the sim's
actual multiplier even if it was seeded differently by `DEMO_SPEED`.

### The tick math (`publishOnce`, every `INTERVAL` seconds — 2 s in compose)

```go
speed := ctl.speedMultiplier()                          // controlState.speed, min 1
battery.ageDays += intervalSeconds / 86400.0 * speed * ctl.degradationAccel
driveCycleStep(&drive, intervalSeconds, speed)          // tripDist += v × dt × speed
```

Two independent multipliers, multiplied together in the aging line:

| Env (compose) | Default | What it scales |
|---|---|---|
| `DEMO_SPEED` (= 5) | 1 | **Simulation time** — drive-cycle progress, brake-energy accumulation, and the base rate of degradation accrual. 1 = real-time, 5 = fast demo, 20 = showcase. |
| `DEGRADATION_ACCEL` (= 1200) | 1 | **Extra aging** beyond speed — the demo sets it high so a 120-day degradation horizon collapses into a 1–3 minute showcase (`120 d / (5 × 1200)` ≈ 2 real minutes). |

Net effect at the compose defaults: the drive cycle advances 5× (the route
dot laps quickly) while battery/tire aging advances 5 × 1200 = 6000× (health
collapses from 100 → 0 in about two minutes). The `"speed"` action rewrites
only `controlState.speed`; `degradationAccel` stays at its env value.

## 3. What scales — and what deliberately does not

| Quantity | Scaled? | Mechanism |
|---|---|---|
| Trip progress / route dot | Yes | `tripDist += velocity × dt × speed` (`driveCycleStep`) |
| Brake-energy accumulator | Yes | `brakeEnergyJ += speed × m·\|Δv\|·v_avg` per braking tick |
| Degradation accrual (age) | Yes (× 2) | `ageDays += dt_days × speed × degradationAccel` |
| **Published sensor values** | **No** | `BatteryAt(ageDays)`, `TirePressureAt`, velocity, SOC etc. all emit **normal-scale** magnitudes |

The published values staying normal scale is the whole point: `DEMO_SPEED`
accelerates **time, not physics**. A 90 km/h cruise still reads 90 km/h on the
speed channel, battery voltage still reads 12.6 → 11.0 V, tire pressure still
reads 2.3 → 1.0 bar. What the consumer sees is the same plausible values
arriving with a **fast-moving trend** — so the detector EWMA/slope math, the
chart y-ranges and the severity thresholds all stay physically meaningful.
Scaling the values themselves would fake the data (a 2000 V battery or a
46 bar tire) and break the detectors' thresholds. See
[simulator-data-generation.md §2](../../sample-clients/vehicle-client/docs/simulator-data-generation.md)
for the full argument.

One subtlety: `DEGRADATION_ACCEL` affects only the **aging** line
(`ageDays`). The drive cycle advances at `speed` alone, which is why the route
dot laps at 5× while the battery dies at 6000× — the vehicle drives a handful
of laps over its entire compressed lifetime.

## 4. The PM pipeline under fast mode

The detector is the consumer that turns the accelerated time into a health
curve:

```mermaid
sequenceDiagram
    autonumber
    participant SIM as vehicle-simulator
    participant BT as "Bigtable (emulator)"
    participant API as "data-api (gRPC :9090)"
    participant PM as "predictive-maintenance (per-VIN job)"
    participant WEB as "/pm board"

    Note over SIM: "ticks every 2 s; ageDays += dt × speed × accel"
    SIM->>BT: "telemetry-generic.{VIN}.battery + telemetry.{VIN} (via connector)"
    PM->>API: "every poll_interval_seconds (60 s default)"
    API-->>PM: "last battery_window_days (30 d) of rows"
    PM->>PM: "EWMA (α=0.1) + least-squares slope (mV/day) over sim-time x-axis"
    PM-->>WEB: "pm.{VIN}.{component} (health_score, severity, evidence) per poll"
```

- **Poll cadence**: the service schedules one recurring job per pool VIN
  (`main.py` → `PmScheduler.schedule_analysis`), firing every
  `poll_interval_seconds` — **60 s**, both the config default
  (`config/config.py`) and the compose value (`POLL_INTERVAL_SECONDS=60` in
  `local-dev/docker-compose.yml`).
- **Query window**: each poll fetches the last `battery_window_days` = **30 d**
  of rows from data-api — at 6000× aging, that window holds only the most
  recent ~7 real minutes of sim time, so the trend it fits is exactly the
  fast-collapsing arc.
- **Detector math**: `detect_battery` runs an EWMA with `BATTERY_EWMA_ALPHA =
  0.1` over the compensated resting voltages and a least-squares slope in
  mV/day (`detectors.py`); tires get the same slope treatment in bar/month
  (`TIRE_SLOPE_BAR_M`); brakes score on the wear fraction. The slope reads the
  accelerated trend because the x-axis is **simulated days** (`t / 86400` of
  the row timestamps) — at 120 sim-days per ~2 real minutes, a battery
  collapsing 12.6 → 11.0 V registers a slope of thousands of mV/day instead
  of the real-time −0.5 mV/day threshold, which is exactly what makes the
  severity rules fire.
- **Publish cadence**: the processor publishes **every poll** for every
  component (demo mode — see the comment in `processor.py`), so the `/pm`
  board's health meters drop continuously over a few minutes instead of
  waiting for a band change.
- **Backfill**: on startup the simulator publishes ~`BACKFILL_DAYS` (compose:
  60) of simulated history at one sim-day per row, so the detector's 30-day
  window and slope fire within the first minute of a fresh stack instead of
  staying silent.

The `/pm` page polls the sim's status reply (every 3 s) for the live
voltage/pressure ground truth and subscribes the `pm.{VIN}.{component}` NATS
stream for the authoritative health scores; the health chart merges the two so
it never sits empty while the death arc plays out.

## 5. Control actions reference

The simulator subscribes `commands.>` and honors these actions
(`controlState.handle` in `sample-clients/vehicle-client/main.go`; the web
wraps them via `/api/demo/vehicle`):

| Action | Request JSON | Effect |
|---|---|---|
| `start` | `{"action":"start","vin":"VIN1002","component":"all","preset":""}` | Enables components; a `vin` differing from the active VIN **adopts** it first (rebinds identity, reseeds degradation curves, clears drive/battery state). `component` omitted = all components. |
| `stop` | `{"action":"stop","vin":"VIN1002"}` | Disables components (pauses the ticker; NATS connection stays alive). |
| `status` | `{"action":"status","vin":"VIN1002"}` | Returns `{vin, running, published, messageType, components, ground_truth, speed, degradation_accel, route, live}` — the dashboard's discovery + live-values source. |
| `reset` | `{"action":"reset","vin":"VIN1002"}` | Restores the demo starting state (battery age 0, fresh drive cycle, zeroed brake accumulator); keeps the current speed multiplier. |
| `speed` | `{"action":"speed","vin":"VIN1002","preset":"5"}` | Rewrites the demo-speed multiplier at runtime (multiplier in the `preset` field, parsed as float ≥ 1). |
| `degradation` | `{"action":"degradation","component":"battery","preset":"critical"}` | Rewrites a component's degradation trajectory (`battery` / `tires` / `all`; preset `healthy` / `degrading` / `critical`). Not surfaced in the web UI; used by scripts and testing. |

Replies go to the request's reply subject; every action other than
`status`/`reset` returns the same status payload, so the UI updates from the
single authoritative reply.

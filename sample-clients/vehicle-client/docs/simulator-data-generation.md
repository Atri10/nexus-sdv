# Simulator Data Generation — how the vehicle-simulator produces telemetry

> Audience: engineers working on the local demo stack or extending the
> predictive-maintenance pipeline. This document explains how the
> `vehicle-simulator` (the Go `vehicle-client` in NATS control mode) generates
> the telemetry that flows into Bigtable and drives the PM detectors and the
> `/demo` + `/pm` dashboards.

## 1. Two personalities in one binary

`sample-clients/vehicle-client/main.go` is both:

- a **real vehicle client** (mTLS cert flow → Keycloak JWT → NATS publish), and
- the **local demo simulator** when run in NATS control mode (`-control-subject`
  set, the docker-compose default).

The simulator personality:

- subscribes `commands.>` (wildcard) and **adopts the requested pool VIN on
  start** — Start on VIN1002 runs a fresh VIN1002 vehicle;
- walks a **degradation model** (battery/tires/brakes) against a simulated
  clock;
- publishes both protobuf families (`MetricsReport`/`VehicleTelemetryData` on
  `telemetry.{VIN}`, `TelemetryMessage` readings on
  `telemetry-generic.{VIN}.{sensor}`);
- answers control requests (`start`/`stop`/`status`/`reset`) with a status
  reply carrying the live values + per-wheel ground truth.

The `/pm` console exposes this model through **Test fault**. Choose one
component (`Battery failure`, `Tire failure`, or `Brake wear`) and an intensity
(`Progressive` or `Failure test`), then choose **Apply + reset**. The command
resets simulated age and brake energy, marks the other modeled components
healthy, and restarts the simulator only if it was already running. This makes
component-by-component PM testing deterministic instead of inheriting the
fleet's default mixed presets.

## 2. The simulation clock: DEMO_SPEED × DEGRADATION_ACCEL

Two independent multipliers drive "how fast things happen" (`controlState`):

| Env | Default | What it scales |
|---|---|---|
| `DEMO_SPEED` | 1 | Simulation time — trip progress, degradation accrual, brake energy. 1 = real-time, 5 = fast demo, 20 = showcase. Published **sensor values stay at normal scale** (a 90 km/h cruise reads 90 km/h, not 1800). |
| `DEGRADATION_ACCEL` | 1 | Additional aging multiplier beyond speed — the demo sets it high (e.g. 1200) so component health visibly trends downward within a 1–3 minute showcase instead of a 120-day real-time horizon. |

The two are **multiplied** in the tick loop: the sim advances
`ageDays += dt_days × speed × degradationAccel` while the drive-cycle clock
advances `dt × speed`. Net effect for a showcase:

- the vehicle drives laps at 20× (the map dot moves fast),
- the battery/tires degrade at `DEMO_SPEED × DEGRADATION_ACCEL` (6000× in the
  compose demo; health drops from 100 → 0 in ~2 min),
- published sensors (voltage 12.6→11.0 V, pressure 2.3→0.9 bar) always read
  realistic magnitudes — only the *trend rate* is accelerated.

### Why not scale the sensor values themselves?

Scaling the values would fake the data — a 2000 V battery or 46 bar tire is
physically absurd and breaks the PM detectors' thresholds. The demo accelerates
**time**, not **physics**, so every consumer (detector EWMA, chart y-ranges,
severity rules) sees plausible numbers with a fast-moving trend.

## 3. The degradation model (per-component physics)

`sample-clients/vehicle-client/degradation.go` implements first-principles
curves (PyBaMM-inspired offline fits for the battery). Every degradable
component gets a `DegradationConfig` with a `Preset` (healthy/degrading/
critical) and a `HorizonDays`:

### 3.1 Battery (`BatteryAt(day)`)

Returns `(V_rest, V_min, R_int_mohm)` at simulated day:

- `V_rest` declines on a sqrt-ish sulfation curve: fast early drop, plateau,
  then a terminal collapse as the horizon approaches;
- `R_int` rises roughly linearly with degradation;
- at the failure horizon the simulator records the battery as terminal —
  `wear_fraction=1`, `days_to_failure=0`, and SoC `0%`. The live voltage is a
  physical terminal reading (about `12.00 V` at the threshold), not a charge
  percentage and not expected to become `0 V`; the PM console uses the
  ground-truth wear label to show battery health `0%`.
- if the curve is evaluated beyond the horizon, `V_rest` collapses toward
  ~10.5 V and internal resistance spikes. The simulator stops at the horizon,
  so the final status normally shows the threshold reading rather than a
  later post-failure sample.

`V_min`/`R_int` drive the **cranking signature** the detector reads
(`vmin < CRANK_VMIN` → critical).

### 3.2 Tires (`TirePressureAt(wheel, day)` + `TireTempAt(wheel, day)`)

Per-wheel pressure with a 3-phase leak curve:

1. **Slow puncture**: linear leak ~0.2 bar/month (severity-scaled) until the
   pressure crosses the ~1.9 bar flex threshold;
2. **Under-inflation feedback**: sidewall flexing overheats the tire and
   accelerates the leak;
3. **Structural collapse**: the tire goes flat (~1.0 bar).

**Wheels are staggered** (`wheelOffsetDays`: FL=0, FR=15, RL=30, RR=45) so
asymmetric degradation is visible — FL fails first while FR/RL/RR hold 2.3 bar.
Healthy presets never leak (pressure stays 2.3 bar).

`TireTempAt` adds a 28 °C mean ± 8 °C diurnal cycle + flex heating.

### 3.3 Brakes (`BrakeWearAt(pad, totalEnergyJ)`)

Per-pad baseline wear fraction (0..1) =
`totalEnergyJ × padWearBias(pad) / 6e9`. The selected brake preset applies an
additional fault multiplier: healthy `1×`, degrading `2×`, critical `4×`.
This changes pad life consumption while preserving realistic energy and pedal
signals:

| Pad | Bias |
|---|---|
| FL | 1.4× |
| FR | 1.25× |
| RL | 0.8× |
| RR | 0.55× |

Front pads wear faster (sum = 4.0, so the mean pad = the legacy overall
fraction before the fault multiplier). `totalEnergyJ` comes from the drive
cycle's brake-energy accumulator. A brake fault raises PM brake wear but does
not automatically stop the vehicle; the vehicle continues so engineers can
inspect the brake alert and per-pad trend.

## 4. The drive cycle + trip route

`driveState` walks a **four-phase cycle** each tick:

- **accelerate** (throttle up), **cruise** (hold a city 50 / highway 90 km/h
  target, 130 km/h hard cap), **brake** (decelerate), **idle** (stop).

Braking dissipates energy into the accumulator (`m·|Δv|·v_avg` per tick, mass
1500 kg) which feeds the brake-wear model. The **trip route** is a fixed loop
(`trip_route.go`); `positionAt(day)` returns lat/lng/heading, and the map dot
advances at `DEMO_SPEED`. The status reply reports lap number + progress.

## 5. What gets published (per VIN)

`buildPayloads` emits:

- `telemetry.{VIN}` — `MetricsReport` wrapping `VehicleTelemetryData` with the
  typed single-channel fields (battery voltage/SOC, TIRE_PRESSURE, TIRE_TEMP,
  BRAKE_PEDAL_PCT, VELOCITY, GPS, …) — **back-compat path**;
- `telemetry-generic.{VIN}.battery` — battery TelemetryMessage;
- `telemetry-generic.{VIN}.chassis` — one TelemetryMessage **per wheel** with
  `TIRE_PRESSURE.{FL,FR,RL,RR}`, `TIRE_TEMP.{FL,FR,RL,RR}`,
  `BRAKE_WEAR.{FL,FR,RL,RR}` (the per-wheel path the connector stores as
  `dynamic:<sensor>` columns, which the PM detector polls).

The **status reply** (`stateLocked`) carries the live values + ground truth:
`tires.{wheel}.{pressure_bar,temp_c}`, `brakes.{wheel}.wear_fraction`,
`battery.{voltage,wear_fraction,days_to_failure}`, route/lap/speed. The
dashboards and the PM evaluator read this to show + verify per-wheel health.

## 6. The control protocol (start/stop/status/reset)

The sim subscribes `commands.>` and honors:

```json
{"action": "start",  "vin": "VIN1002", "component": "all", "preset": ""}
{"action": "stop"}
{"action": "status"}
{"action": "reset"}
{"action": "degradation", "component": "battery", "preset": "critical"}
```

`start` with a `vin` **adopts** that VIN (rebinds identity + reseeds
degradation + clears drive state); `reset` reseeds age/energy to a fresh start
while keeping the active presets;
`degradation` rewrites a component's preset for instant state changes. Valid
components are `battery`, `tires`, `brake`, `all`, or empty (all). Valid
presets are `healthy`, `degrading`, and `critical`. The `status` reply also
includes the active presets under `degradation`.

## 7. The two time dimensions (why the detector sees fast slopes)

The PM detector's EWMA/slope run over **simulated days**. With
`DEGRADATION_ACCEL=1200`, 120 sim-days pass in ~2 real minutes, so the slope
reads −31080 mV/day — a fast-forward artifact that is *physically coherent*
(the voltage really is collapsing that fast in sim time). The detector treats
it as real because it has no clock: it sees a battery dropping 12.6 → 11.0 V
over its polling window. This is correct — the demo shows a *compressed
lifecycle*, not fake values.

## 8. Extending the simulator

To add a component:

1. Add a `DegradationConfig` curve in `degradation.go` (or extend an existing
   one);
2. Emit the sensor(s) in `buildPayloads` (typed field for back-compat, and/or a
   TelemetryMessage reading for the generic path);
3. Add it to `degradableComponents` + the `controlState` registry;
4. Add the ground-truth fields to `stateLocked` for the status reply;
5. The detector (Python) polls the new `dynamic:<sensor>` column — no connector
   change needed (it's generic per-sensor).

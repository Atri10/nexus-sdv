# Predictive Maintenance — Brake Pads: Detection Algorithm from First Principles

Date: 2026-08-14
Status: **Reference / first-principles explainer — algorithm theory grounded in the current code**
Purpose: The brake-pad wear detection algorithm from the physics up: why pad wear is proportional to friction work, how the energy integral is approximated from driving telemetry, where the 6 GJ pad budget comes from, and how the detector and simulator share one algebraic identity so validation stays honest. Every formula is grounded in the code (`File(fn)` citations — file name + function name, stable against line edits) and every worked example is reproducible by hand. This is an algorithms-only document. The companion implementation doc maps each equation to the exact code: `2026-08-14-pm-algorithms-implementation.md`.

> **Shipped reality (as of `97ebe3e`)**: the simulator now publishes **per-pad wear** as `BRAKE_WEAR.{pad}` (fraction 0..1 of pad life), and the detector consumes it directly — per-pad model is the primary path. The legacy energy-accumulator estimate (`VELOCITY` + `BRAKE_PEDAL_PCT` → `m·|Δv|·v_avg` → `E/6GJ`) is now the **fallback** for older sims / mixed history that lack the `BRAKE_WEAR.*` columns. Both paths are described below; the energy-integral physics remains accurate for the fallback.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-battery-first-principles.md`
- `2026-08-14-pm-algorithms-tires-first-principles.md`

Signal definitions (what each raw telemetry parameter means, incl. `BRAKE_PEDAL_PCT` and the `BRAKE_WEAR.*` per-pad columns) are in the glossary section of `2026-08-14-pm-algorithms-implementation.md`.

### Signal sourcing — where each raw parameter comes from

| Quantity the detector consumes | Proto source | Bigtable qualifier | Emitted by (simulator) | Algorithm step |
|---|---|---|---|---|
| Per-pad wear `w_{pad}` | — (not a proto field; rides the generic telemetry path) | `dynamic:BRAKE_WEAR.{pad}`, pad ∈ {FL, FR, RL, RR} | `buildChassisWheelTelemetry` from `BrakeWearAt(wheel, brakeEnergyJ)` (`main.go`) | Primary path: `detect_brake(wear, pad=w)` per pad |
| Vehicle speed `v` *(fallback)* | `VehicleTelemetryData.VELOCITY` (field 9) | `dynamic:VELOCITY` | `buildChassisReport` from `drive.velocity` | `a = Δv/Δt`, `v_avg` for the energy integral |
| Brake pedal position *(fallback)* | `CarlaVehicleDynamics.brake_pedal_pct` (field 3) | `dynamic:BRAKE_PEDAL_PCT` | `buildChassisReport` from `drive.brakePct` (set during the brake phase, `driveCycleStep`) | Gate only (`> 5.0`) — never enters an alert |
| Odometer `distance_meters` | `VehicleTelemetryData.distance_meters` (field 12) | — (connector never persists it) | — | Missing → no `wear_rate_per_km`, no RUL (§4.3) |

The full chain (physics → proto → NATS → Bigtable → data-api → processor → detector) is traced in `2026-08-15-pm-use-case-end-to-end.md`.

---

## 1. Why pad wear ∝ friction work

### 1.1 Tribology basis

Braking converts kinetic energy into heat at the pad/rotor interface. Material removal from the pad is proportional to the energy dissipated there — an Archard-type proportionality: the same friction work removes (roughly) the same pad volume, regardless of how it is spread over time. A panic stop and ten gentle stops that dissipate the same total energy wear the pads about the same.

### 1.2 From estimate to direct sensor — the per-pad model

Early designs (and the fallback path below) inferred wear from driving data because the schema had **no direct wear sensor**. That changed: the simulator now publishes a **wear fraction per pad**, `BRAKE_WEAR.{pad}` ∈ [0, 1], where `1.0` means "pad life exhausted". The detector consumes this directly:

- `detect_brake` runs **once per pad** (FL/FR/RL/RR), each fed the last `BRAKE_WEAR.{pad}` value in the window.
- Results are keyed `brake.{pad}` and published on `pm.{VIN}.brake.{pad}` — four independent health meters per vehicle, not one.

The physics of §1.1 still explains *why* the sim's wear values are what they are: each pad's wear fraction is derived from the braking energy that pad absorbed (`BrakeWearAt(wheel, brakeEnergyJ)`, §5), so the direct sensor and the energy view agree by construction.

---

## 2. The physics — the energy integral *(fallback path)*

The energy-accumulator estimator below is now the **fallback**: it runs only when the `BRAKE_WEAR.*` columns are absent (older sim / mixed-history windows). Its physics is unchanged and still accurate; it just no longer is the primary signal.

### 2.1 Continuous form

Braking force is `F = m·a` (Newton), and work is force over distance: `W = ∫ F·ds`. With `ds = v·dt`:

```
W = ∫ m·a·v dt
```

over each braking event. This is the friction work dissipated at the pads.

### 2.2 Discrete approximation (the trapezoid)

Telemetry is sampled, not continuous. Over one sample interval `Δt` with constant deceleration:

```
W_event = m·a·v_avg·Δt        (trapezoidal rule: v_avg = ½(v₁ + v₀))
```

Since `a = Δv/Δt`, the interval cancels:

```
W_event = m·|Δv|·v_avg
```

This is exactly `½·m·(v₀² − v₁²)` — the kinetic-energy bookkeeping of the step — so the trapezoid is exact for constant deceleration. The processor computes `a = (vel − prev_v)/dt` from the velocity delta and accumulates `m·|a|·v_avg·dt` (`processor.py(run)`); the `dt` used is the **real sample spacing** between rows, not the poll interval (a locked regression contract, `tests/test_processor_cadence.py`).

### 2.3 Worked example

1.5 t vehicle braking from 15 m/s (54 km/h) to 0 at 2.5 m/s²:

- Braking distance `d = v²/(2a) = 225/5 = 45 m`
- `W = 1500 kg × 2.5 m/s² × 45 m = 168,750 J ≈ 0.17 MJ per stop`

Cross-checked by the trapezoid: `m·|Δv|·v_avg = 1500 × 15 × 7.5 = 168,750 J` — identical. (The simulator's brake phase decelerates at 3.0 m/s², `main.go(driveCycleStep)`.)

---

## 3. The pad budget — 6 GJ *(fallback path)*

The fallback wear index needs a denominator: the total braking energy a pad set can absorb over its life. A plausible value for a 1.5 t passenger car:

```
E_budget ≈ 6 GJ   (= m·a·d with 10 % of 40,000 km braked at 1 m/s²:
                    1500 × 1 × 4,000,000 m = 6×10⁹ J)
```

It is a **calibrated per-vehicle-class constant**, not a physical law. It lives in code twice, deliberately identical:

- `BRAKE_ENERGY_BUDGET_J = 6.0e9` — detector service (`processor.py(top)`)
- `brakeEnergyBudgetJ = 6.0e9` — simulator (`degradation.go(top)`)

The evaluator mirrors the service constant (`evaluate_detectors.py(top)`), so all three sides agree.

In the per-pad world the same budget still anchors the numbers: the simulator converts accumulated braking energy to an overall wear fraction `E/6GJ` and then **distributes** it across the four pads with the per-pad bias of §5, so the *mean* pad wear equals the legacy overall fraction.

---

## 4. Wear index, scoring, and thresholds

### 4.1 Per-pad model (primary)

```
wear_fraction = BRAKE_WEAR.{pad}          (sim publishes, already in [0,1])
health_score  = 100·(1 − wear_fraction)   (continuous; rounded, clamped)
```

The processor takes the **last** wear value per pad and clamps defensively before calling the detector: `detect_brake(min(1.0, max(0.0, wear)), pad=w)` (`processor.py(run)`); the simulator clamps identically on its side.

Alert rules (`detectors.py(top)`, `detectors.py(detect_brake)`):

| Condition (per pad, on `wear_fraction`) | Level |
|---|---|
| wear > 90 % (`BRAKE_ACTION`) | Action — replace before long trips |
| wear > 80 % (`BRAKE_ADVISORY`) | Advisory — plan replacement at next service |
| else | Healthy |

Note this is the **only** detector whose severity comes from wear thresholds directly, not from the score band: wear 0.85 → score 15 (band would say action) but the explicit branch says advisory; wear 0.75 → score 25 (band would say action) but the explicit branch says healthy. The meter itself stays continuous in the wear fraction — 0 % at fully worn, 100 % at new — while severity stays threshold-driven.

### 4.2 Per-pad asymmetry (what the demo now shows)

The sim publishes **asymmetric** pad wear via `BrakeWearAt(wheel, brakeEnergyJ)` with bias multipliers:

| Pad | Bias | Effect |
|---|---|---|
| FL | ×1.4 | wears fastest |
| FR | ×1.25 | |
| RL | ×0.8 | |
| RR | ×0.55 | wears slowest |

The four biases sum to 4.0, so the mean pad wear equals the legacy overall `E/6GJ` fraction. Consequence: the front pads cross the 80 % advisory and 90 % action thresholds **before** the rears — asymmetric wear across the axle is now visible in `pm.{VIN}.brake.{pad}`, matching real-world front-heavy pad wear.

### 4.3 Fallback path (no `BRAKE_WEAR.*` columns)

```
wear_fraction = min(1, W_accum / E_budget)      (clamped to [0,1])
health_score  = 100·(1 − wear_fraction)          (rounded, clamped)
```

The processor clamps before calling the detector (`processor.py(run)`); the simulator clamps identically in `brakeWearFraction` (`main.go(brakeWearFraction)`). Same severity thresholds as §4.1 (wear > 90 % action, > 80 % advisory), published on the single subject `pm.{VIN}.brake`.

Evidence carries `wear_fraction` and `wear_rate_per_km` — the latter is **not wired** (always `0.000000`): the optional parameter is never passed and the spec's RUL formula `RUL_km = (E_budget − W_accum)/wear_rate_km` cannot be computed without a per-km rate. The implementation is a wear-fraction detector only.

---

## 5. The detector/simulator algebraic identity

The strongest design property: the simulator's ground-truth wear uses the **same budget** as the detector, and the per-pad path is derived from the same energy bookkeeping the fallback uses.

| Quantity | Detector side | Simulator side |
|---|---|---|
| Per-pad wear (primary) | `detect_brake(wear, pad=w)` on last `BRAKE_WEAR.{w}` (`processor.py(run)`) | `BrakeWearAt(wheel, brakeEnergyJ)` — bias FL=1.4x, FR=1.25x, RL=0.8x, RR=0.55x, mean = `E/6GJ` (`main.go`) |
| Energy per step (fallback) | `m·|Δv|·v_avg` (`processor.py(run)`) | `speed·1500·|velocity−vStart|·0.5·(vStart+velocity)` (`main.go(driveCycleStep)`) |
| Mass | 1500 kg (`processor.py(top)`) | 1500 kg (literal) |
| Budget | 6 GJ (`processor.py(top)`) | 6 GJ (`degradation.go(top)`) |
| Clamp (fallback) | `min(1, E/6e9)` (`processor.py(run)`) | `clamp(E/6e9, 0, 1)` (`main.go(brakeWearFraction)`) |

The comment at `main.go(driveCycleStep)` states it explicitly: "algebraically identical to the processor's velocity-delta estimate (m·|Δv|·v_avg, mass 1500 kg), so detector and truth stay comparable."

Why this matters: because the sim is the source of truth, high precision/recall are **circular evidence** — they prove the detector reproduces the formulas, not that the formulas predict real failures. The identity's real value is catching *implementation* divergence (the poll-interval regression guard is exactly this) and demonstrating the alert timeline. The per-pad path is even simpler: the detector consumes the sim's published wear almost directly, so the evaluator mainly proves the *plumbing* (column → processor → per-pad subject) and the *thresholds*.

Two honest caveats to the identity (fallback path):
- **Gate asymmetry**: the simulator gates on `brakePct > 5 && velocity > 0.5` only; the processor gates on `brake_pct > 5`, `a < −0.5` m/s² **and** `v_avg > 0.5` m/s. A gentle brake that the simulator counts may not pass the processor's deceleration gate.
- **Demo speed**: the simulator's accumulator scales with the `speed` multiplier (`main.go(driveCycleStep)`) — fast-forwarding the demo consumes pad life faster per wall-second while velocity values stay at normal scale. The processor's live estimate does not see the multiplier directly; it only sees the published rows.

---

## 6. Gating conditions as implemented *(fallback path only)*

The processor accumulates brake energy only when (`processor.py(run)`):

1. A row carries **both** `dynamic:VELOCITY` and `dynamic:BRAKE_PEDAL_PCT`.
2. `brake_pedal_pct > 5.0` — the pedal is engaged (the pedal value is a gate only; it never enters the alert).
3. `dt = t − prev_t > 0` — real sample spacing, not the poll interval.
4. `a = (vel − prev_v)/dt < −0.5` m/s² — a real deceleration.
5. `v_avg = 0.5·(vel + prev_v) > 0.5` m/s — the vehicle is still moving.

Worked (test-locked): two rows 5 s apart, 20 → 15 m/s (a = −1 m/s²), brake_pct 40 → per-tick energy `1500·|−1|·17.5·5 = 131,250 J`; with a shrunken budget of 150,000 J the wear is `0.875` → advisory (`tests/test_processor_cadence.py`). This cadence regression test also locks the per-pad `BRAKE_WEAR.{wheel}` columns into the window request (`tests/test_processor_cadence.py`).

The per-pad primary path has **no gating**: a row carrying `BRAKE_WEAR.{pad}` is used directly, regardless of pedal/deceleration state.

---

## 7. Limitations and honest notes

1. **No odometer, no RUL**: `distance_meters` is not persisted by the connector, so `wear_rate_per_km` cannot be computed — the spec's RUL extension is not implemented (both paths).
2. **No driving-style factor**: the spec's aggressive-driver multiplier (×1.25) is not implemented; wear is purely energy-based.
3. **Single budget for all vehicle classes**: 6 GJ / 1500 kg is hard-coded; a heavier or lighter vehicle class would need its own calibration.
4. **Rolling window**: the processor polls a 30-day window (`config.py(top)`), so per-pad wear (and fallback brake energy) only reflects the rows in that window — the wear fraction is a windowed estimate, not a lifetime odometer.
5. **Brake ground truth accrues live only**: the history backfill deliberately does not step the drive cycle ("velocity math would explode", `main.go(PublishTelemetryContinuously)`), so a fresh stack has no per-pad wear history until the live loop runs.
6. **Per-pad bias is sim-side, not physics**: the FL=1.4x…RR=0.55x multipliers are a demo convention (front pads wear faster in reality); the detector consumes whatever fractions it is given.

---

## 8. Summary

Brake wear is modeled **per pad**: the simulator publishes `BRAKE_WEAR.{pad}` fractions (FL=1.4x, FR=1.25x, RL=0.8x, RR=0.55x bias over the 6 GJ energy bookkeeping), the processor feeds the last value of each pad to `detect_brake`, and `pm.{VIN}.brake.{pad}` carries four continuous meters `100·(1 − wear)` with advisory/action at 80 %/90 % wear. The legacy energy integral `W = Σ m·|Δv|·v_avg` against the 6 GJ budget remains — physics intact — as the **fallback** when the `BRAKE_WEAR.*` columns are absent. RUL (per-km rate) and driving-style factors are the documented, unimplemented extensions.

---

## 9. Cross-links

- **Implementation** — theory→code map, exact constants, and the live deltas: `2026-08-14-pm-algorithms-implementation.md`
- **Battery first principles** — resting-voltage trend + cranking signature: `2026-08-14-pm-algorithms-battery-first-principles.md`
- **Tires first principles** — ideal-gas pressure compensation: `2026-08-14-pm-algorithms-tires-first-principles.md`


## 10. Sources

The friction-work model (pad wear ∝ dissipated braking energy, `W = ∫ m·a·v dt` against a 6 GJ per-pad-set budget for a 1500 kg passenger car) is a standard physics-derived wear estimator; the energy-budget calibration (`E_budget ≈ 6 GJ` from m·a·d over ~40,000 km at 10 % braking) is a literature-typical value, not a fleet-calibrated constant. Full source list, links, and the calibration notes (budget, mass, the unimplemented RUL / driving-style extensions): `2026-08-18-pm-algorithms-sources.md`.
# Predictive Maintenance — Brake Pads: Detection Algorithm from First Principles

Date: 2026-08-14
Status: **Reference / first-principles explainer — algorithm theory grounded in the current code**
Purpose: The brake-pad wear detection algorithm from the physics up: why pad wear is proportional to friction work, how the energy integral is approximated from driving telemetry, where the 6 GJ pad budget comes from, and how the detector and simulator share one algebraic identity so validation stays honest. Every formula is grounded in the code (`File(fn)` citations — file name + function name, stable against line edits) and every worked example is reproducible by hand. This is an algorithms-only document. The companion implementation doc maps each equation to the exact code: `2026-08-14-pm-algorithms-implementation.md`.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-battery-first-principles.md`
- `2026-08-14-pm-algorithms-tires-first-principles.md`

Signal definitions (what each raw telemetry parameter means, incl. `BRAKE_PEDAL_PCT`) are in the glossary section of `2026-08-14-pm-algorithms-implementation.md`.

---

## 1. Why pad wear ∝ friction work

### 1.1 Tribology basis

Braking converts kinetic energy into heat at the pad/rotor interface. Material removal from the pad is proportional to the energy dissipated there — an Archard-type proportionality: the same friction work removes (roughly) the same pad volume, regardless of how it is spread over time. A panic stop and ten gentle stops that dissipate the same total energy wear the pads about the same.

### 1.2 Why estimate from driving data

Most vehicles (including this schema) have **no direct wear sensor**. Pad wear must be inferred from what is observable: the deceleration, the speed, and the brake-pedal use. The estimator is an energy integral — accumulate braking energy over time, compare to a calibrated budget.

---

## 2. The physics — the energy integral

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

## 3. The pad budget — 6 GJ

The wear index needs a denominator: the total braking energy a pad set can absorb over its life. A plausible value for a 1.5 t passenger car:

```
E_budget ≈ 6 GJ   (= m·a·d with 10 % of 40,000 km braked at 1 m/s²:
                    1500 × 1 × 4,000,000 m = 6×10⁹ J)
```

It is a **calibrated per-vehicle-class constant**, not a physical law. It lives in code twice, deliberately identical:

- `BRAKE_ENERGY_BUDGET_J = 6.0e9` — detector service (`processor.py(top)`)
- `brakeEnergyBudgetJ = 6.0e9` — simulator (`degradation.go(top)`)

The evaluator mirrors the service constant (`evaluate_detectors.py(top)`), so all three sides agree.

---

## 4. Wear index, scoring, and thresholds

```
wear_fraction = min(1, W_accum / E_budget)      (clamped to [0,1])
health_score  = 100·(1 − wear_fraction)          (rounded, clamped)
```

The processor clamps before calling the detector (`processor.py(run)`); the simulator clamps identically in `brakeWearFraction` (`main.go(brakeWearFraction)`).

Alert rules (`detectors.py(top)`, `detectors.py(detect_brake)`):

| Condition | Level |
|---|---|
| wear index > 80 % (`BRAKE_ADVISORY`) | Advisory — plan replacement at next service |
| wear index > 90 % (`BRAKE_ACTION`) | Action — replace before long trips |

Note this is the **only** detector whose severity comes from wear thresholds directly, not from the score band: wear 0.85 → score 15 (band would say action) but the explicit branch says advisory.

Evidence carries `wear_fraction` and `wear_rate_per_km` — the latter is **not wired** (always `0.000000`): the optional parameter is never passed and the spec's RUL formula `RUL_km = (E_budget − W_accum)/wear_rate_km` cannot be computed without a per-km rate. The implementation is a wear-fraction detector only.

---

## 5. The detector/simulator algebraic identity

The strongest design property: the simulator's ground-truth accumulator uses the **same formula, same mass, same budget** as the detector.

| Quantity | Detector side | Simulator side |
|---|---|---|
| Energy per step | `m·|Δv|·v_avg` (`processor.py(run)`) | `speed·1500·|velocity−vStart|·0.5·(vStart+velocity)` (`main.go(driveCycleStep)`) |
| Mass | 1500 kg (`processor.py(top)`) | 1500 kg (literal) |
| Budget | 6 GJ (`processor.py(top)`) | 6 GJ (`degradation.go(top)`) |
| Clamp | `min(1, E/6e9)` (`processor.py(run)`) | `clamp(E/6e9, 0, 1)` (`main.go(brakeWearFraction)`) |

The comment at `main.go(driveCycleStep)` states it explicitly: "algebraically identical to the processor's velocity-delta estimate (m·|Δv|·v_avg, mass 1500 kg), so detector and truth stay comparable."

Why this matters: because the sim is the source of truth, high precision/recall are **circular evidence** — they prove the detector reproduces the formulas, not that the formulas predict real failures. The identity's real value is catching *implementation* divergence (the poll-interval regression guard is exactly this) and demonstrating the alert timeline.

Two honest caveats to the identity:
- **Gate asymmetry**: the simulator gates on `brakePct > 5 && velocity > 0.5` only; the processor gates on `brake_pct > 5`, `a < −0.5` m/s² **and** `v_avg > 0.5` m/s. A gentle brake that the simulator counts may not pass the processor's deceleration gate.
- **Demo speed**: the simulator's accumulator scales with the `speed` multiplier (`main.go(driveCycleStep)`) — fast-forwarding the demo consumes pad life faster per wall-second while velocity values stay at normal scale. The processor's live estimate does not see the multiplier directly; it only sees the published rows.

---

## 6. Gating conditions as implemented

The processor accumulates brake energy only when (`processor.py(run)`):

1. A row carries **both** `dynamic:VELOCITY` and `dynamic:BRAKE_PEDAL_PCT`.
2. `brake_pedal_pct > 5.0` — the pedal is engaged (the pedal value is a gate only; it never enters the alert).
3. `dt = t − prev_t > 0` — real sample spacing, not the poll interval.
4. `a = (vel − prev_v)/dt < −0.5` m/s² — a real deceleration.
5. `v_avg = 0.5·(vel + prev_v) > 0.5` m/s — the vehicle is still moving.

Worked (test-locked): two rows 5 s apart, 20 → 15 m/s (a = −1 m/s²), brake_pct 40 → per-tick energy `1500·|−1|·17.5·5 = 131,250 J`; with a shrunken budget of 150,000 J the wear is `0.875` → advisory (`tests/test_processor_cadence.py`).

---

## 7. Limitations and honest notes

1. **No odometer, no RUL**: `distance_meters` is not persisted by the connector, so `wear_rate_per_km` cannot be computed — the spec's RUL extension is not implemented.
2. **No driving-style factor**: the spec's aggressive-driver multiplier (×1.25) is not implemented; wear rate is purely energy-based.
3. **Single budget for all vehicle classes**: 6 GJ / 1500 kg is hard-coded; a heavier or lighter vehicle class would need its own calibration.
4. **Rolling window**: the processor polls a 30-day window (`config.py(top)`), so brake energy only accumulates over the rows in that window — the wear fraction is a windowed estimate, not a lifetime odometer.
5. **Brake ground truth accrues live only**: the history backfill deliberately does not step the drive cycle ("velocity math would explode", `main.go(PublishTelemetryContinuously)`), so a fresh stack has no brake-wear history until the live loop runs.

---

## 8. Summary

Brake wear is estimated as an energy integral: `W = Σ m·|Δv|·v_avg` per braking step against a calibrated 6 GJ budget, with a wear index `W/6GJ` and advisory/action lines at 80 %/90 %. The detector and the simulator share the identical formula, mass, and budget — the honest-validation design that makes the offline evaluator meaningful. RUL (per-km rate) and driving-style factors are the documented, unimplemented extensions.

---

## 9. Cross-links

- **Implementation** — theory→code map, exact constants, and the live deltas: `2026-08-14-pm-algorithms-implementation.md`
- **Battery first principles** — resting-voltage trend + cranking signature: `2026-08-14-pm-algorithms-battery-first-principles.md`
- **Tires first principles** — ideal-gas pressure compensation: `2026-08-14-pm-algorithms-tires-first-principles.md`

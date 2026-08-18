# Predictive Maintenance — Tires (Slow Leak / Pressure): Detection Algorithm from First Principles

Date: 2026-08-14
Status: **Reference / first-principles explainer — algorithm theory grounded in the current code**
Purpose: The tire slow-leak detection algorithm from the physics up: the ideal-gas law behind temperature compensation, why a slow leak is invisible in raw pressure, the slope-in-bar/month trend rule, and the absolute floor. Every formula is grounded in the code (`File(fn)` citations — file name + function name, stable against line edits) and every worked example is reproducible by hand. This is an algorithms-only document. The companion implementation doc maps each equation to the exact code: `2026-08-14-pm-algorithms-implementation.md`.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-battery-first-principles.md`
- `2026-08-14-pm-algorithms-brake-first-principles.md`

Signal definitions (what each raw telemetry parameter means, incl. `BRAKE_PEDAL_PCT`) are in the glossary section of `2026-08-14-pm-algorithms-implementation.md`.

### Signal sourcing — where each raw parameter comes from

| Quantity the detector consumes | Proto source | Bigtable qualifier | Emitted by (simulator) | Algorithm step |
|---|---|---|---|---|
| Tyre pressure `P` | `VehicleTelemetryData.TIRE_PRESSURE` (field 8) — per-wheel columns `TIRE_PRESSURE.{wheel}`, wheel ∈ FL/FR/RL/RR | `dynamic:TIRE_PRESSURE.{wheel}` | `buildChassisWheelTelemetry` from `TirePressureAt(ageDays + wheelOffsetDays)` — staggered per-wheel failure, FL first (offsets FL=0/FR=15/RL=30/RR=45 days) | Raw input to `P_comp = P·293.15/T` |
| Tyre temperature `T` | `VehicleTelemetryData.TIRE_TEMP` (field 16) — per-wheel columns `TIRE_TEMP.{wheel}`, wheel ∈ FL/FR/RL/RR | `dynamic:TIRE_TEMP.{wheel}` | `buildChassisWheelTelemetry` from `TireTempAt(ageDays + wheelOffsetDays)` (28 ± 8 °C cycle + flex heat) | Denominator of compensation (processor adds 273.15 → Kelvin) |

The full chain (physics → proto → NATS → Bigtable → data-api → processor → detector) is traced in `2026-08-15-pm-use-case-end-to-end.md`.

---

## 1. Ideal-gas basis

Tire pressure follows the ideal-gas law: `P·V = n·R·T`. Volume is roughly fixed, so pressure is proportional to **absolute** temperature. The sensitivity at a typical 2.3 bar is:

```
ΔP per 10 °C ≈ P·10/293.15 ≈ 0.078 bar
```

A 10 °C swing moves pressure by ~0.08 bar — **larger than a typical slow-leak signature** (permeation baseline ≈ 0.05 bar/month). Raw pressure therefore hides a leak inside weather noise; compensation is mandatory before any trend is meaningful.

---

## 2. Temperature compensation — the implemented form

```
P_comp = P · T_ref / T        (T in Kelvin, T_ref = 293.15 K = 20 °C)
```

The reference is `TIRE_REF_K = 293.15` (`detectors.py(top)`); the processor converts the °C reading to Kelvin at collection time by adding 273.15 (`processor.py(run)`). (Note: the tire reference is 20 °C, deliberately different from the battery's India-calibrated 30 °C — the two compensations are independent.)

Worked: P = 2.3 bar at 30 °C (303.15 K) → `P_comp = 2.3 × 293.15/303.15 = 2.2241 bar` — the same number the tests lock (`tests/test_detectors.py(test_tires_temp_compensation)`). The `T > 0` guard drops Kelvin-invalid samples.

The simulator's temperature model is a 28 °C mean with a ±8 °C daily cycle — `TireTempAt(day) = 28 + 8·sin(day·2π)` (°C, `degradation.go(TireTempAt)`), the India regime. At the hot phase (36 °C) a 2.3 bar reading compensates to `2.3·293.15/309.15 = 2.181 bar`; at the cold phase (20 °C) the same raw reading compensates to `2.3·293.15/293.15 = 2.3 bar` — the ±0.12 bar daily swing in P_comp is exactly what compensation removes.

---

## 3. Leak physics

Normal tires lose ~0.05 bar/month to permeation. A slow leak is 0.05–0.25 bar/month. The demo leak curve (`degradation.go(TirePressureAt)`) runs per wheel with a staggered failure onset — FL fails first, then FR/RL/RR at 15/30/45-day offsets:

```
healthy   → 2.3 bar (no leak)
degrading/critical → P(day) = 2.3 − leak·(day − wheelOffset)/30,  leak = 0.2·norm(day − wheelOffset)
```

The leak term is quadratic in day until the horizon clamps `norm`: worked at day 45 of horizon 120 → `leak = 0.2·(45/120) = 0.075`, `P = 2.3 − 0.075·45/30 = 2.1875 bar`.

---

## 4. Trend detection — slope in bar/month

After compensation, a linear fit over the samples detects sustained drift. The code's x-axis is **months** (`t/86400/30`), so the slope comes out directly in bar/month (`detectors.py(detect_tires)`):

```
slope_bar_m = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²        (x = month, y = P_comp)
```

The rule: `slope < −0.15 bar/month` (`TIRE_SLOPE_BAR_M`, `detectors.py(top)`) → advisory. This is loss **above** the normal permeation baseline.

### 4.1 The 0.1 bar/month blind spot

A 0.1 bar/month leak is *not* slope-alerted (it sits above −0.15). It is caught later by the absolute floor: 2.3 → 1.8 bar at 0.1 bar/month takes ~5 months. Leaks ≥ 0.15 bar/month trigger the slope rule directly (~2–3 weeks of data). This is an honest, documented limitation — the slope rule trades early detection against false alarms.

Worked (test-locked): 2.30 → 1.75 bar linear over 30 days at 303.15 K → after compensation the series runs 2.224 → 1.693 bar; the compensated slope is −0.532 bar/month (well below −0.15, but the floor already binds) (`tests/test_detectors.py(test_tires_slow_leak_slope_advisory)`).

### 4.2 Per-wheel detection (x4)

`detect_tires` runs once per wheel — FL/FR/RL/RR — each consuming its own sensor columns (`TIRE_PRESSURE.{wheel}` / `TIRE_TEMP.{wheel}`), results keyed `tires.{wheel}`, and published per wheel on `pm.{VIN}.tires.{wheel}` (`detectors.py(detect_tires)`, `processor.py(run)`). The whole pipeline above (compensation, OLS slope, floor, meter) applies identically to each wheel; the staggered sim failure means the four meters diverge at 0/15/30/45 days of sim age instead of failing together.

---

## 5. The continuous health meter and severity

The meter is continuous in compensated pressure — no step-function floors:

```
score = round(clamp((last_p − 0.9) / (2.3 − 0.9) · 100, 0, 100))
```

2.3 bar = 100, 0.9 bar = 0 (`detectors.py(detect_tires)`, per wheel). `last_p` is the **last compensated pressure** (`comp[-1][1]`). Severity is decoupled from the score and threshold-driven:

```
last_p < 1.2 bar               → critical
last_p < 1.8 bar (TIRE_FLOOR_BAR) → action
slope < −0.15 bar/month (TIRE_SLOPE_BAR_M) → advisory
else → _band(score)
```

Slope penalty retained: `score = min(score, 55)` when the slope rule binds — the slope can pull the meter down, but the meter itself is the continuous pressure score. `_band` (`detectors.py(_band)`): ≥70 healthy, ≥50 advisory, else action.

Worked: a tire collapsing 1.7 → 0.9 bar reads `round((1.7−0.9)/1.4·100) = 57 → 0`; below 1.8 bar the floor already binds (action), so the meter's low end is severity-capped before it reaches 0.

**14-sample minimum**: fewer than 14 compensated samples → hard `healthy` with score 100 and "Insufficient tire data." — the minimum for a stable OLS fit (`detectors.py(detect_tires)`).

Evidence:

```
{"p_comp_bar": "2.224", "slope_bar_month": "-0.0861",
 "threshold_slope": "-0.15", "floor_bar": "1.8"}
```

---

## 6. Detection limits and honest gaps

1. **Wheel localization shipped**: per-wheel pressure/temp columns (`TIRE_PRESSURE.{wheel}` / `TIRE_TEMP.{wheel}`) are now in the schema and the detector runs per wheel — the alert says "front-left" via `tires.{wheel}` / `pm.{VIN}.tires.{wheel}`. What remains future work is *per-wheel speed* (the indirect-TPMS signal, gap 5).
2. **No steady-driving filter**: the spec's "sample only at steady driving (v > 10 m/s, > 5 min into trip, small |dv/dt|)" is **not implemented** — every row with both pressure and temp is fed to the detector (`processor.py(run)`). The 14-sample guard and OLS averaging are the only noise mitigation.
3. **Noise sources in the demo**: the ±8 °C daily temp cycle (compensated out) plus the chassis-report noise (±0.05 bar, ±0.25 °C, `main.go(buildChassisReport)`) are what the slope fit must survive.
4. **Compensation depends on TIRE_TEMP**: that field exists (`vehicle_telemetry.proto`, field 16) and is emitted on the typed metrics path; without it the compensation is impossible.
5. **Indirect TPMS (UNECE R64)**: comparing per-wheel speeds (an underinflated wheel rotates faster) is the standard ABS-based upgrade path — it catches symmetrical leaks too — but needs per-wheel speed signals, which are not in the schema (per-wheel PRESSURE/TEMP are; per-wheel SPEED remains a future path).

---

## 7. Summary

Tire leak detection runs per wheel (x4, `tires.{wheel}` / `pm.{VIN}.tires.{wheel}`): ideal-gas compensation (`P_comp = P·293.15/T`) followed by a bar/month slope fit against a −0.15 bar/month rule, a 1.8 bar absolute floor, and a continuous health meter (`(last_p − 0.9)/1.4·100`, 2.3 bar = 100). Compensation is the whole game: a 10 °C swing moves pressure more than a month of leakage. The 0.1 bar/month blind spot and the missing steady-driving filter are the documented limitations; wheel localization (per-wheel pressure/temp) is shipped, while per-wheel speeds for indirect TPMS remain a future path.

---

## 8. Cross-links

- **Implementation** — theory→code map, exact constants, and the live deltas: `2026-08-14-pm-algorithms-implementation.md`
- **Battery first principles** — resting-voltage trend + cranking signature: `2026-08-14-pm-algorithms-battery-first-principles.md`
- **Brake first principles** — friction-work wear model: `2026-08-14-pm-algorithms-brake-first-principles.md`

## 9. Sources

The ideal-gas temperature compensation (`P_comp = P·T_ref/T`, `T_ref = 293.15 K`) is the ideal-gas law applied to tire pressure; the slow-leak physics (a ~0.05 bar/month permeation baseline, a ±0.078 bar per 10 °C sensitivity) is standard radial-tire behavior. The **UNECE R64** regulation (indirect TPMS — per-wheel speed comparison) is the documented future path for localizing leaks when per-wheel *speed* signals exist (per-wheel pressure/temp are already shipped). Full source list, links, and calibration notes: `2026-08-18-pm-algorithms-sources.md`.

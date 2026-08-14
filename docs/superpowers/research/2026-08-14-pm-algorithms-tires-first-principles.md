# Predictive Maintenance — Tires (Slow Leak / Pressure): Detection Algorithm from First Principles

Date: 2026-08-14
Status: **Reference / first-principles explainer — algorithm theory grounded in the current code**
Purpose: The tire slow-leak detection algorithm from the physics up: the ideal-gas law behind temperature compensation, why a slow leak is invisible in raw pressure, the slope-in-bar/month trend rule, and the absolute floor. Every formula is grounded in the code (`File(fn)` citations — file name + function name, stable against line edits) and every worked example is reproducible by hand. This is an algorithms-only document. The companion implementation doc maps each equation to the exact code: `2026-08-14-pm-algorithms-implementation.md`.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-battery-first-principles.md`
- `2026-08-14-pm-algorithms-brake-first-principles.md`

Signal definitions (what each raw telemetry parameter means, incl. `BRAKE_PEDAL_PCT`) are in the glossary section of `2026-08-14-pm-algorithms-implementation.md`.

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

Normal tires lose ~0.05 bar/month to permeation. A slow leak is 0.05–0.25 bar/month. The demo leak curve (`degradation.go(TirePressureAt)`):

```
healthy   → 2.3 bar (no leak)
degrading/critical → P(day) = 2.3 − leak·day/30,  leak = 0.2·norm(day)
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

---

## 5. The absolute floor and scoring

```
P_comp < 1.8 bar (TIRE_FLOOR_BAR)   → score = min(score, 20)   → action
slope < −0.15 bar/month             → score = min(score, 55)   → advisory
severity = "action" if score < 30 else _band(score)
```

`last_p` is the **last compensated pressure** (`comp[-1][1]`) — the floor rule is a current-value rule, not a trend rule. Score 20 from the floor → action; score 55 from the slope alone → advisory; both → 20 → action. `_band` (`detectors.py(_band)`): ≥70 healthy, ≥50 advisory, else action.

**14-sample minimum**: fewer than 14 compensated samples → hard `healthy` with score 100 and "Insufficient tire data." — the minimum for a stable OLS fit (`detectors.py(detect_tires)`).

Evidence:

```
{"p_comp_bar": "2.224", "slope_bar_month": "-0.0861",
 "threshold_slope": "-0.15", "floor_bar": "1.8"}
```

---

## 6. Detection limits and honest gaps

1. **No wheel localization**: the schema carries one scalar `TIRE_PRESSURE` — the alert says "pressure low/leaking", never "front-left". Per-wheel pressure is the natural upgrade.
2. **No steady-driving filter**: the spec's "sample only at steady driving (v > 10 m/s, > 5 min into trip, small |dv/dt|)" is **not implemented** — every row with both pressure and temp is fed to the detector (`processor.py(run)`). The 14-sample guard and OLS averaging are the only noise mitigation.
3. **Noise sources in the demo**: the ±8 °C daily temp cycle (compensated out) plus the chassis-report noise (±0.05 bar, ±0.25 °C, `main.go(buildChassisReport)`) are what the slope fit must survive.
4. **Compensation depends on TIRE_TEMP**: that field exists (`vehicle_telemetry.proto`, field 16) and is emitted on the typed metrics path; without it the compensation is impossible.
5. **Indirect TPMS (UNECE R64)**: comparing per-wheel speeds (an underinflated wheel rotates faster) is the standard ABS-based upgrade path — it catches symmetrical leaks too — but needs per-wheel speed signals not in the schema.

---

## 7. Summary

Tire leak detection is ideal-gas compensation (`P_comp = P·293.15/T`) followed by a bar/month slope fit against a −0.15 bar/month rule, plus a 1.8 bar absolute floor. Compensation is the whole game: a 10 °C swing moves pressure more than a month of leakage. The 0.1 bar/month blind spot, the missing steady-driving filter, and the single-scalar (no wheel localization) are the documented limitations.

---

## 8. Cross-links

- **Implementation** — theory→code map, exact constants, and the live deltas: `2026-08-14-pm-algorithms-implementation.md`
- **Battery first principles** — resting-voltage trend + cranking signature: `2026-08-14-pm-algorithms-battery-first-principles.md`
- **Brake first principles** — friction-work wear model: `2026-08-14-pm-algorithms-brake-first-principles.md`

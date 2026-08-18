# Predictive Maintenance — 12V Starter Battery: Detection Algorithm from First Principles

Date: 2026-08-14
Status: **Reference / first-principles explainer — algorithm theory grounded in the current code**
Purpose: The 12V starter-battery detection algorithm from the physics up: why resting open-circuit voltage (OCV) indicates state of health (SoH), why temperature compensation is mandatory, why exponential smoothing + a linear trend is the right tool, and how the cranking signature catches near-term failure. Every formula is grounded in the code (`File(fn)` citations — file name + function name, stable against line edits) and every worked example is reproducible by hand. This is an algorithms-only document. The companion implementation doc maps each of these equations to the exact code that runs it: `2026-08-14-pm-algorithms-implementation.md`.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-brake-first-principles.md`
- `2026-08-14-pm-algorithms-tires-first-principles.md`

Signal definitions (what each raw telemetry parameter means, incl. `BRAKE_PEDAL_PCT`) are in the glossary section of `2026-08-14-pm-algorithms-implementation.md`.

### Signal sourcing — where each raw parameter comes from

| Quantity the detector consumes | Proto source | Bigtable qualifier | Emitted by (simulator) | Algorithm step |
|---|---|---|---|---|
| Resting voltage `V_rest` | `TelemetryMessage.SensorReading{sensor: "battery.voltage"}` (string value) | `dynamic:battery.voltage` | `buildBatteryTelemetry` from `BatteryAt(ageDays)` (`main.go(publishOnce)`) | Input to temp compensation → EWMA + slope |
| Battery temperature `T` | `SensorReading{sensor: "battery.temp"}` | `dynamic:battery.temp` | `buildBatteryTelemetry` reusing `TireTempAt(ageDays)` | Compensation temperature (forward-filled last-known) |
| Cranking `V_min` / `I_crank` (M2) | — (never published) | `dynamic:battery.current` exists but is dead data | `BatteryAt` computes them but `publishOnce` discards (`_ = vMin; _ = rInt`) | Dormant — see implementation doc §8.2 |

The full chain (physics → proto → NATS → Bigtable → data-api → processor → detector) is traced in `2026-08-15-pm-use-case-end-to-end.md`.

---

## 1. Why resting OCV indicates health

### 1.1 Electrochemistry in one paragraph

A lead-acid cell is a pair of electrodes in sulfuric acid. The cell's open-circuit voltage is set by the Nernst equation — it depends on the acid concentration (and temperature), and for a resting, unloaded battery the acid concentration at the plates tracks how much charge is stored. That makes OCV a monotonic function of state of charge (SoC): a fully charged cell sits near 12.6–12.7 V (for a 6-cell 12 V battery), a depleted one near 11.9 V.

### 1.2 Why SoC maps to SoH

The detection trick: an aging battery holds less charge. As plates sulphate and active material is lost, the same charging profile leaves the battery at a lower resting voltage. So a battery whose resting voltage drifts downward over weeks — under the same usage pattern — is losing capacity: SoH is falling. The OCV→SoC curve is the standard lookup:

| OCV (V, at 25 °C) | ≈ SoC |
|---|---|
| 12.65 | 100 % |
| 12.45 | 75 % |
| 12.24 | 50 % |
| 12.06 | 25 % |
| 11.89 | 0 % |

The code's advisory line, `BATTERY_ADVISORY_V = 12.4` V (`detectors.py(top)`), sits at ≈75 % SoC on this curve; `BATTERY_ACTION_V = 12.2` V just below it. The simulator's aging curve `vRest = 12.63 − 0.63·deg` (`degradation.go(BatteryAt)`) walks from the healthy ceiling to 12.0 V at full degradation — matching the OCV floor of the curve.

### 1.3 The failure profile

Battery failure is gradual: resting voltage declines over weeks-to-months (sulfation), and cranking performance degrades in the last days (rising internal resistance). Two complementary detectors therefore make sense — a slow trend detector (weeks ahead) and a fast cranking detector (days ahead).

---

## 2. Temperature dependence — why compensation is mandatory

Battery voltage depends on temperature: at the same SoC, a cold battery reads *higher* and a hot one *lower* (roughly −0.011 V/°C for a 12 V lead-acid — `BATTERY_BETA`, `detectors.py(top)`). A seasonal swing of 30 °C moves readings by ~0.33 V — larger than the entire advisory band. Without compensation, winter looks like a battery recovering and summer hides a real decline.

```
V_comp = V_rest − β·(T − T_ref)      β = −0.011 V/°C
```

The research doc's canonical example used a 25 °C reference; the code is India-calibrated with `BATTERY_V_REF = 30.0` °C (`detectors.py(top)`), so the implemented form is:

```
V_comp = V − BATTERY_BETA·(T − 30)   = V + 0.011·(T − 30)
```

Worked example (both readings are the same battery, same health):

- Cold morning, T = 5 °C: measured 12.77 V → V_comp = 12.77 + 0.011·(5 − 30) = 12.77 − 0.275 = **12.495 V**
- Hot afternoon, T = 35 °C: measured 12.44 V → V_comp = 12.44 + 0.011·(35 − 30) = 12.44 + 0.055 = **12.495 V**

Raw readings differ by 0.33 V; compensated readings agree exactly. The compensation is applied in the processor before detection (`processor.py(run)`), which consumes already-compensated voltages (`detectors.py(detect_battery)`).

---

## 3. EWMA — exponential smoothing of resting readings

A resting reading is noisy (measurement noise, load transients, residual current). The algorithm smooths with an exponentially weighted moving average — a 10 % weight on the newest sample (`BATTERY_EWMA_ALPHA = 0.1`, `detectors.py(top)`):

```
e_0 = V_comp(0)
e_t = (1 − α)·e_{t−1} + α·V_comp(t),   α = 0.1
```

The key property: each new reading moves the average only a little — high-frequency noise is suppressed while real drift survives. Worked sequence (readings 12.60, 12.55, 12.52, 12.48, 12.50):

```
e = 12.600 → 12.595 → 12.588 → 12.577 → 12.569
```

The code seeds with the first sample and recurses over the rest (`detectors.py(detect_battery)`). The advisory-slope test series (12.60 → 12.40 V linear over 30 days) lands at EWMA = 12.4638 V (`tests/test_detectors.py(test_battery_degrading_slope_advisory)`) — the smoother visibly lags the raw series and damps the 0.20 V swing.

---

## 4. Trend slope — ordinary least squares over 30 days

EWMA gives the current level; the *slope* gives the direction. The code fits a linear least-squares line over the window, with x in **calendar days** (`t/86400`):

```
slope = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²        (x = day, y = V_comp)
slope_mv_day = slope · 1000
```

The ×1000 converts V/day to mV/day. Why −0.5 mV/day (`BATTERY_SLOPE_MV`, `detectors.py(top)`) as the rule? It sits well above the noise floor of daily readings (roughly ±0.33 mV/day from ±0.025 V noise at daily spacing) and 7–10× below realistic degradation rates — a genuinely failing battery declines at several mV/day, so the rule separates drift from noise. Worked: 12.60 → 12.40 V over 30 days ⇒ slope = −0.0067 V/day = **−6.67 mV/day**, far below the rule (this is the test's advisory series).

The denominator guard (`if den else 0.0`) collapses all-equal timestamps to slope 0.0 — harmless, since 0 > −0.5.

---

## 5. Cranking signature (M2) — the near-term detector

When the starter motor engages, the battery sags under load. Two quantities capture health:

- **V_min** — the voltage minimum during cranking. A weak battery sags below ~9.5 V (`CRANK_VMIN`, `detectors.py(top)`).
- **Internal resistance** — estimated from the sag and the cranking current:

```
R_int = (V_rest − V_min) / I_crank
```

Worked (the spec's example): V_rest = 12.6 V, V_min = 10.1 V, I_crank = 180 A → R_int = 2.5/180 = **13.9 mΩ**. Against a 6-month baseline of 9.3 mΩ (`CRANK_BASELINE_MOHM`, `detectors.py(top)`) that is 1.49× — right at the alert line. The rule is `R_int > 1.5 × baseline` (`CRANK_R_MULT`, `detectors.py(top)`). Internal resistance rises as plates sulphate; it is the most reliable near-term failure indicator. The code computes `r_int = (12.6 − vmin)/ic · 1000` (mΩ) inside `detectors.py(detect_battery)`.

The 9.5 V and 1.5× thresholds are the literature-typical cranking limits for a 12 V starter system; the simulator's `vMin = 10.8 − 1.3·deg` (`degradation.go(BatteryAt)`) ends at exactly 9.5 V at full degradation, so the "dead battery" lines up with the detector's alert line.

---

## 6. Threshold derivation and scoring

### 6.1 The alert lines

| Condition | Level | Lead time |
|---|---|---|
| EWMA < 12.4 V (≈75 % SoC) or slope < −0.5 mV/day | Advisory | ~2 weeks |
| EWMA < 12.2 V | Action | days–weeks |
| EWMA < 11.8 V (ACTION − 0.4) | Critical | days |
| Cranking V_min < 9.5 V | Critical | days |
| R_int > 1.5× baseline | Score penalty only (severity via `_band`) | days |

### 6.2 Continuous health meter (voltage-derived score)

The health score is no longer composed from step-function caps. It is a **continuous meter** mapping the EWMA resting voltage onto a 0–100 scale (`detectors.py(detect_battery)`):

```
score = round(clamp((ewma − 10.5) / (12.63 − 10.5) · 100, 0, 100))
```

EWMA resting voltage **12.63 V → 100 (healthy)** down to **10.5 V → 0 (dead)**. The meter is linear in the smoothed voltage, so it tracks the actual death arc: a battery collapsing 11.3 → 10.5 V reads 30 → 0, not a frozen 25. The threshold rules below then only **add** penalty (slope / cranking); they never override the voltage-derived score.

| Rule | Effect on score |
|---|---|
| Continuous meter (EWMA voltage) | `score = min(score, round(clamp((ewma−10.5)/(12.63−10.5)·100, 0, 100)))` |
| `slope_mv_day < BATTERY_SLOPE_MV` (−0.5 mV/day) | `score = min(score, 55)` |
| cranking `vmin < CRANK_VMIN` (9.5 V) | `score = min(score, 20)` |
| cranking `R_int > 1.5×` baseline | `score = min(score, 30)` |

The voltage meter always applies (when resting data exists); slope and cranking penalties stack via `min` as before. The binding constraint wins — the score is never higher than the worst single penalty.

### 6.3 Severity mapping (threshold-driven, decoupled from score)

Severity is the **alert signal** and comes from the threshold rules, evaluated in order — not from the score. This matters: a battery at 12.10 V is below the 12.2 V action line and must alert as **action** even though its continuous score (~75) still reads high. The score is the degradation *meter*; the threshold rules are the *alerts* (`detectors.py(detect_battery)`).

```
if ewma < BATTERY_ACTION_V − 0.4   (11.8 V) → "critical"
elif ewma < BATTERY_ACTION_V       (12.2 V) → "action"
elif ewma < BATTERY_ADVISORY_V     (12.4 V) → "advisory"
elif any crank vmin < CRANK_VMIN   (9.5 V)  → "critical"
else → _band(score)
```

with `_band` (`detectors.py(_band)`): ≥70 → healthy, ≥50 → advisory, else action. Full mapping: **EWMA < 11.8 V → critical; EWMA < 12.2 V → action; EWMA < 12.4 V → advisory; crank V_min < 9.5 V → critical; else ≥ 70 → healthy, ≥ 50 → advisory, < 50 → action**.

### 6.4 Worked example — the collapse of a dying battery

A battery walking down the EWMA resting voltage (temperature-compensated), with no slope or cranking penalty:

| EWMA resting voltage | Score | Severity |
|---|---|---|
| 12.60 V | (12.60−10.5)/(12.63−10.5)·100 = 99.3 → **99** | healthy (≥70, and ≥12.4 V) |
| 12.40 V | (12.40−10.5)/(12.63−10.5)·100 = 89.2 → **89** | advisory (12.40 ≥ 12.2, < 12.4) |
| 12.10 V | (12.10−10.5)/(12.63−10.5)·100 = 75.1 → **75** | action (12.10 < 12.2) |
| 11.60 V | (11.60−10.5)/(12.63−10.5)·100 = 51.6 → **52** | critical (11.60 < 11.8) |
| 10.50 V | (10.50−10.5)/(12.63−10.5)·100 = 0 → **0** | critical |

The meter reads the actual state: **12.10 V → score 75, severity action** — the alert comes from the threshold rule while the score stays informative. Under the old step-function caps the same battery floored at a frozen 25.

### 6.5 Insufficient-data guard

Fewer than five resting samples **and** no cranking data → hard `healthy` with score 100 (`detectors.py(detect_battery)`). Five is the minimum for a meaningful EWMA/OLS fit given the 10 % weight; crank data bypasses the guard entirely (one strong cranking event can alert).

---

## 7. Limitations and honest notes

1. **No ignition-state gate**: the spec's "resting reading = engine off, no load" extraction is not implemented — the detector consumes whatever the processor labels as a battery row (`processor.py(run)`). In the demo, all samples are resting-ish by construction.
2. **M2 is dormant end-to-end**: the simulator never emits cranking events (`BatteryAt` computes `vMin`/`rInt` but the publish loop discards them, `main.go(publishOnce)`), so `crank` is always empty in the live pipeline and the critical path is only reachable via EWMA < 11.8 V (or action below 12.2 V). Unit tests exercise M2 directly (`tests/test_detectors.py(test_battery_cranking_critical)`).
3. **Calibration**: β and the OCV→SoC curve are literature-typical values; the simulator is the calibration instrument, not fleet data.
4. **Code-vs-spec scoring divergence**: the spec proposed a composite weighted score (60 % resting trend / 25 % cranking / 15 % SOC drift, §3.3 above); the code implements a continuous voltage-derived meter plus threshold penalties and has **no SOC term at all** (the processor does not even request `dynamic:battery.soc`). The weights were never transcribed into code.
5. **Explanation template quirk**: when resting data exists the explanation is always the fixed "Resting voltage … drifting … mV/day (advisory threshold 12.4 V)" template; the `or ("; ".join(reasons))` fallback is dead code (a formatted string is never falsy), so the actual trigger (action EWMA, slope) is hidden from the explanation. See the implementation doc §3.9.
6. **Single-channel by design**: the battery stays a single component — one `pm.{VIN}.battery` subject, no per-wheel split. Per-wheel channels exist only where the physics is per-corner (tires `pm.{VIN}.tires.{wheel}`, brake pads `pm.{VIN}.brake.{pad}`); the battery's resting-voltage and cranking physics are inherently vehicle-level.

---

## 8. Summary

The battery detector is a two-speed physics-informed detector: a **slow trend channel** (temperature-compensated resting voltage → EWMA level + 30-day OLS slope) that warns weeks ahead, and a **fast cranking channel** (V_min + internal resistance vs baseline) that catches the near-term failure. All thresholds are deterministic and explainable; the score is a continuous voltage-derived meter, severity comes from the threshold rules, and the missing SOC term is the one deliberate divergence from the spec.

---

## 9. Cross-links

- **Implementation** — theory→code map, exact constants, and the live deltas: `2026-08-14-pm-algorithms-implementation.md`
- **Brake first principles** — friction-work wear model: `2026-08-14-pm-algorithms-brake-first-principles.md`
- **Tires first principles** — ideal-gas pressure compensation: `2026-08-14-pm-algorithms-tires-first-principles.md`


## 10. Sources

The dual-channel detector (resting-OCV trend + cranking V_min/R_int) originates in the Geotab telematics battery-health patent family — **US20110082621A1** ("Method and system for predicting battery life based on vehicle battery, usage, and environmental data"; Geotab is now part of **Verizon Connect**) and its continuation **US11742681** ("Methods for analysis of vehicle battery health"). The "deterministic detection first, LLM validates/narrates only" decision is grounded in **AXIS** (arXiv:2509.24378). Full list, links, and the literature-typical calibration constants (β = −0.011 V/°C, the OCV→SoC curve, the 30 °C India reference): `2026-08-18-pm-algorithms-sources.md`.
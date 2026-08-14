# Predictive Maintenance — Algorithms as Implemented (Code → Math → Why)

Date: 2026-08-14
Status: **Implementation reference — current code as of 2026-08-14 (repo mid-change; anchor to the files and functions named, not to line numbers or operational cadence)**
Purpose: The exact mapping from the algorithm first-principles companions (`2026-08-14-pm-algorithms-{battery,brake,tires}-first-principles.md`) and design (`2026-08-09-predictive-maintenance-prototype-design.md`) into the code that actually runs today: the `predictive-maintenance` detectors, the `Processor` that feeds them, the `vehicle-client` degradation simulator that produces ground truth, and the offline evaluator that scores them. Every formula, constant, and claim below is grounded in a `File(fn)` / `File.py(fn)` citation (file name + function name — stable against future line edits); every worked example is reproducible by hand. This is an algorithms-only document: the one-line pipeline framing is that degraded telemetry flows vehicle → storage → data-api → `Processor` → detectors → `pm.{VIN}.{component}` messages, and nothing else about that plumbing is described here.

Citation convention: `File.py(fn)` = function `fn` in the Python file; `File.go(fn)` = function `fn` in the Go file; `(top)` = module-level constant/field in that file (e.g. `detectors.py(top)` for `BATTERY_EWMA_ALPHA`). All file paths are relative to the repo root as shown in §8.

Companion first-principles docs (same date):
- `2026-08-14-pm-algorithms-battery-first-principles.md`
- `2026-08-14-pm-algorithms-brake-first-principles.md`
- `2026-08-14-pm-algorithms-tires-first-principles.md`

---

## 1. Theory → code map

Every theoretical quantity from the spec documents, its code symbol, its value, and where it lives. Values are hard constants in `detectors.py` (the single source of truth for detector thresholds), `processor.py` (brake physics), `degradation.go` (simulator curves), and `evaluate_detectors.py` (evaluator).

| Theory quantity (spec) | Code symbol | Value | Location (file + symbol owner) |
|---|---|---|---|
| EWMA smoothing weight α | `BATTERY_EWMA_ALPHA` | 0.1 | `detectors.py(top)` |
| Temperature reference (India, spec §3) | `BATTERY_V_REF` | 30.0 °C | `detectors.py(top)` |
| Lead-acid voltage temp coefficient β | `BATTERY_BETA` | −0.011 V/°C | `detectors.py(top)` |
| Advisory resting voltage (~75 % SoC) | `BATTERY_ADVISORY_V` | 12.4 V | `detectors.py(top)` |
| Action resting voltage | `BATTERY_ACTION_V` | 12.2 V | `detectors.py(top)` |
| Sustained 30-day slope rule | `BATTERY_SLOPE_MV` | −0.5 mV/day | `detectors.py(top)` |
| Cranking voltage minimum | `CRANK_VMIN` | 9.5 V | `detectors.py(top)` |
| Cranking R_int multiplier | `CRANK_R_MULT` | 1.5× | `detectors.py(top)` |
| Cranking baseline R_int | `CRANK_BASELINE_MOHM` | 9.3 mΩ | `detectors.py(top)` |
| Brake advisory wear | `BRAKE_ADVISORY` | 0.8 | `detectors.py(top)` |
| Brake action wear | `BRAKE_ACTION` | 0.9 | `detectors.py(top)` |
| Tire temperature reference | `TIRE_REF_K` | 293.15 K (20 °C) | `detectors.py(top)` |
| Tire slope rule | `TIRE_SLOPE_BAR_M` | −0.15 bar/month | `detectors.py(top)` |
| Tire pressure floor | `TIRE_FLOOR_BAR` | 1.8 bar | `detectors.py(top)` |
| Severity vocabulary | `SEVERITIES` | healthy, advisory, action, critical | `detectors.py(top)` |
| Brake pad energy budget | `BRAKE_ENERGY_BUDGET_J` | 6.0e9 J (6 GJ) | `processor.py(top)` |
| Vehicle mass | `VEHICLE_MASS_KG` | 1500.0 kg | `processor.py(top)` |
| Battery poll window | `settings.battery_window_days` | 30 days | `config.py(top)`, used in `processor.py(run)` |
| Pad-life energy budget (sim) | `brakeEnergyBudgetJ` | 6.0e9 J | `degradation.go(top)` |
| Healthy V_rest ceiling | 12.63 | — | `degradation.go(BatteryAt)` |
| Full-degradation V_rest | 12.63 − 0.63 = 12.0 V | — | `degradation.go(BatteryAt)` |
| R_int baseline → full degradation | 9.3 → 9.3 + 6.0 = 15.3 mΩ | — | `degradation.go(BatteryAt)` |
| Cranking V_min baseline → full | 10.8 → 10.8 − 1.3 = 9.5 V | — | `degradation.go(BatteryAt)` |
| Tire healthy baseline | 2.3 bar | — | `degradation.go(TirePressureAt)` |
| Tire leak rate | 0.2 bar/month (norm-scaled) | — | `degradation.go(TirePressureAt)` |
| Tire temp cycle | 28 + 8·sin(2π·day) °C | — | `degradation.go(TireTempAt)` |
| Degradation presets | severityFactor 0 / 0.85 / 1.0 | — | `degradation.go(severityFactor)` |
| Horizons | 120 days; 60 days for critical | — | `main.go(defaultDegradationConfig)` |
| Evaluator budget/mass mirrors | `BRAKE_ENERGY_BUDGET_J`, `VEHICLE_MASS_KG` | 6.0e9 J / 1500 kg | `evaluate_detectors.py(top)` |

Two notes on the map. First, the battery advisory threshold `BATTERY_ADVISORY_V = 12.4` at `detectors.py(top)` is the spec's "≈75 % SoC on the OCV curve" value, hard-coded as a plain float. Second, the brake budget is declared twice — `processor.py(top)` (detector service) and `degradation.go(top)` (simulator) — deliberately, with matching comments: the simulator's accumulator divides by the same 6 GJ so detector wear and ground truth stay comparable; the evaluator mirrors the service's constant (`evaluate_detectors.py(top)`) so it reproduces the wear estimate exactly.

---

## 2. Signal glossary — every raw parameter the algorithms consume

What each telemetry value the detectors read actually is, where it comes from, and which algorithm step uses it. "Qualifier" = the Bigtable column name the data-api returns and the processor filters on (`processor.py(run)`); "proto field" = the source field in the protobuf schema.

| Qualifier (Bigtable / data-api) | Proto field / source | Units | Meaning (what it is) | Used by (which algorithm step) |
|---|---|---|---|---|
| `dynamic:VELOCITY` | `VehicleTelemetryData.VELOCITY` (field 9) | m/s | Vehicle speed (15 m/s ≈ 54 km/h). | Brake energy accumulation: deceleration `a = Δv/Δt` and `v_avg` (`processor.py(run)`); tires would use it for steady-driving gating (not implemented, §8.4). |
| `dynamic:BRAKE_PEDAL_PCT` | `CarlaVehicleDynamics.brake_pedal_pct` (field 3) | % (0–100) | Brake pedal application as a percentage of the pedal's full travel, from the Carla vehicle dynamics model. **Not a pressure/force** — it is pedal *position*. Mapped by the connector to `dynamic:BRAKE_PEDAL_PCT`. In the simulator, `driveState.brakePct` is set during the drive cycle's braking phase to `clamp(20+rand·40, 0, 100)` (`main.go(driveCycleStep)`); the processor uses it as a **gate**: brake energy is only accumulated when `brake_pedal_pct > 5.0` (`processor.py(run)`). The pedal value never appears in an alert — it only enables energy accumulation. |
| `dynamic:TIRE_PRESSURE` | `VehicleTelemetryData.TIRE_PRESSURE` (field 8) | bar | Tyre pressure. | Tires: raw input to ideal-gas compensation `P_comp = P·293.15/T` (`processor.py(run)` → `detectors.py(detect_tires)`). |
| `dynamic:TIRE_TEMP` | `VehicleTelemetryData.TIRE_TEMP` (field 16) | °C | Tyre temperature (added to 273.15 to make Kelvin at collection, `processor.py(run)`). | Tires: temperature side of the compensation; also the battery simulator reuses the same temp cycle for `battery.temp` (`main.go(publishOnce)`). |
| `dynamic:battery.voltage` | `TelemetryMessage.SensorReading` (sensor `battery.voltage`) | V | 12 V battery terminal (resting) voltage. String-encoded, quoted; the processor decodes by stripping quotes (`processor.py(run)`). | Battery: raw input to temperature compensation `V_comp = V + 0.011·(T − 30)` then EWMA + slope (`processor.py(run)` → `detectors.py(detect_battery)`). |
| `dynamic:battery.temp` | `TelemetryMessage.SensorReading` (sensor `battery.temp`) | °C | Battery temperature; used as a forward-filled "last-known" value, not per-row (`processor.py(run)`). | Battery: compensation temperature. |
| `dynamic:battery.current` | `TelemetryMessage.SensorReading` (sensor `battery.current`) | A | Battery current. **Not consumed by the detectors** — cranking current is never simulated, so the M2 internal-resistance formula has no live input (see §8.2). |
| `dynamic:battery.soc` | `TelemetryMessage.SensorReading` (sensor `battery.soc`) | % (0–100) | State of charge. **Not consumed by the detectors** — the spec's 15 % SOC-drift term is unimplemented; the processor does not even request this qualifier (§8.3). |
| `acceleration_modulus_m_s2` | `VehicleTelemetryData.acceleration_modulus_m_s2` (field 11) | m/s² | Acceleration magnitude. **Not used** — the connector does not persist this field, so the processor estimates deceleration from `VELOCITY` deltas instead (`processor.py(run)`). |
| `distance_meters` | `VehicleTelemetryData.distance_meters` (field 12) | m | Odometer distance. **Not used** — not persisted; `wear_rate_per_km` therefore stays 0 and RUL is not computed (§4.3). |
| `IGNITION_STATE` | `VehicleTelemetryData.IGNITION_STATE` (field 7) | bool | Engine on/off (optional — `false` means off, not absent). Not consumed by the current detectors (no rest-vs-driving classification; the spec's gating is unimplemented). |
| `ENGINE_RPM` | `VehicleTelemetryData.ENGINE_RPM` (field 2) | rpm | Engine revolutions per minute. Not consumed by the detectors (would classify rest/cranking; unimplemented). |
| `ENGINE_POWER` | `VehicleTelemetryData.ENGINE_POWER` (field 1) | W | Engine output power. Not consumed by the detectors. |
| `GPS_LATITUDE` / `GPS_LONGITUDE` | `VehicleTelemetryData.GPS_LATITUDE` (5) / `GPS_LONGITUDE` (6) | degrees | GPS coordinates (0.0 is a real coordinate). Not consumed by the detectors. |
| `HEADING_DEG` | `VehicleTelemetryData.HEADING_DEG` (field 15) | degrees | Heading clockwise from north. Not consumed by the detectors. |
| `FUEL_CAPACITY` / `FUEL_LEVEL` | `VehicleTelemetryData.FUEL_CAPACITY` (3) / `FUEL_LEVEL` (4) | L | Fuel tank capacity / current level. Not consumed by the detectors. |
| `LOCKED` | `VehicleTelemetryData.LOCKED` (field 10) | bool | Vehicle locked state. Not consumed by the detectors. |
| `accelerator_pedal_pct` / `steering_angle_deg` | `CarlaVehicleDynamics` fields 2 / 1 | % / deg | Accelerator pedal position, steering angle. Not consumed by the detectors (context for the drive cycle only). |
| `gear_status` | `CarlaVehicleGearStatus` (field 14) | enum | Current gear (UNKNOWN/REVERSE/NEUTRAL/FIRST..FIFTH). Not consumed by the detectors. |

Derived constants the detectors consume (not raw telemetry): `BRAKE_ENERGY_BUDGET_J` / `VEHICLE_MASS_KG` (`processor.py(top)`), the `BATTERY_*` / `CRANK_*` / `BRAKE_*` / `TIRE_*` threshold set (`detectors.py(top)`), and the simulator's matching `brakeEnergyBudgetJ` (`degradation.go(top)`).

---

## 3. Battery as implemented

### 3.1 Data collection (Processor)

`Processor.run` polls the data-api with `last_duration = battery_window_days · 86400` seconds (`processor.py(run)`, `config.py(top)` — default 30 days) and collects `(t_epoch, V_rest, T)` triples:

- `batt_temp` is a running "last-known battery temp" variable seeded to `BATTERY_V_REF` (`processor.py(run)`), updated from `dynamic:battery.temp` when a row carries it, and attached to each voltage row. Because telemetry rows are ordered and the temperature updates as they stream, every resting reading is paired with the most recent observed temperature — a forward-fill, not the reading's own temp.
- The `crank` list stays empty: the simulator never publishes a cranking signature (see §8.2), so `crank` is always `[]` in practice.
- The voltage value arrives as a quoted string and is decoded by stripping quotes (`processor.py(run)`); the same for temp and tire fields.

### 3.2 Temperature compensation — applied BEFORE detection

The detector consumes **already-compensated** voltages. The compensation lives in the caller (`processor.py(run)`):

```
V_comp = V − BATTERY_BETA·(T − BATTERY_V_REF)   = V + 0.011·(T − 30)
```

with `T` = the row's last-known battery temp and `BATTERY_BETA = −0.011`, `BATTERY_V_REF = 30.0` (`detectors.py(top)`). `detect_battery` itself then only peels the compensated `V` off each pair — the comment there says "V already compensated by caller; see note" and the list comprehension `comp = [v for _, v in rest]` re-uses them as-is (`detectors.py(detect_battery)`).

Why in the caller and not the detector? The processor owns the `(V, T)` pairing (it streams rows and forward-fills temperature); the detector is a pure function of a `(t, V_comp)` series plus an optional crank series. The evaluator repeats the exact same compensation in its own poll loop (`evaluate_detectors.py(run_detectors_for_vin)`) before calling `detect_battery` — and its first-alert-epoch helper applies the same formula to raw rows (`evaluate_detectors.py(_first_alert_epoch)`), so alert detection and lead-time math agree on the compensated series.

Worked example (same numbers the tests use): a battery at 40 °C resting 12.10 V → `V_comp = 12.10 − (−0.011)·(40 − 30) = 12.10 + 0.11 = 12.21 V`. Without compensation the raw 12.10 V would be read as below the 12.2 V action line; compensated, it sits just above it.

### 3.3 EWMA recurrence

`detectors.py(detect_battery)`:

```
e_0 = V_comp(0)
e_t = (1 − α)·e_{t−1} + α·V_comp(t),   α = 0.1
```

First sample seeds the EWMA; every later sample moves it 10 % toward the new value. Worked (the advisory-slope test series, 12.60 → 12.40 V linear over 30 days, `tests/test_detectors.py(test_battery_degrading_slope_advisory)`): the EWMA lands at 12.4638 V after 30 samples — the smoothing visibly lags the raw series and damps the 0.20 V swing.

### 3.4 OLS slope

`detectors.py(detect_battery)`: ordinary least squares on `(x = t/86400 in days, y = V_comp)`, then scaled by 1000:

```
slope_mv_day = [ Σ(x−x̄)(y−ȳ) / Σ(x−x̄)² ] · 1000
```

Two things worth calling out. First, the denominator-zero guard — `slope_mv_day = (num / den * 1000.0) if den else 0.0` — a single sample (or all-equal timestamps) yields den = 0 and a slope of exactly 0.0, which is above the −0.5 rule and therefore harmless. Second, the x-axis is **row timestamp** (`t/86400.0`), not row index — the slope is calendar-days-accurate even when samples are unevenly spaced, which matters because the detector window is a 30-day lookback (`processor.py(run)`) over daily-ish simulator rows.

Worked: the same 30-day 12.60 → 12.40 V series gives slope = −6.67 mV/day (verified by hand), far below the −0.5 mV/day rule; the test asserts this series is advisory (`tests/test_detectors.py(test_battery_degrading_slope_advisory)`).

### 3.5 Score penalties and minimum composition

Score starts at 100 (`detectors.py(detect_battery)`) and only ever decreases via `min`:

| Rule | Penalty | Location |
|---|---|---|
| `ewma < BATTERY_ACTION_V` (12.2 V) | `score = min(score, 25)` | `detectors.py(detect_battery)` |
| else `ewma < BATTERY_ADVISORY_V` (12.4 V) | `score = min(score, 60)` | `detectors.py(detect_battery)` |
| `slope_mv_day < BATTERY_SLOPE_MV` (−0.5 mV/day) | `score = min(score, 55)` | `detectors.py(detect_battery)` |
| cranking `vmin < CRANK_VMIN` (9.5 V) | `score = min(score, 20)` | `detectors.py(detect_battery)` |
| cranking `R_int > 1.5·baseline` | `score = min(score, 30)` | `detectors.py(detect_battery)` |

The `min` composition is the key property: each rule can only pull the score down to its own cap, so the binding constraint wins and the final score is the *minimum of the applied caps* (the score can never be higher than the worst single violation). Then `score = max(0, score)`.

The EWMA branches are `if/elif` — the action line subsumes the advisory line (a battery below 12.2 V is also below 12.4 V, and the 25 cap is strictly lower than the 60 cap, so `elif` preserves the min). Slope and cranking rules are independent `if`s and stack multiplicatively via `min`.

### 3.6 Severity mapping

`detectors.py(detect_battery)`:

```
severity = "critical" if score < 30 else _band(score)
```

with `_band` at `detectors.py(_band)`: `≥70 → healthy`, `≥50 → advisory`, else `action`. So the full battery mapping is: **< 30 → critical; 30–49 → action; 50–69 → advisory; ≥ 70 → healthy**. The `score < 30` critical branch is the one place the battery deviates from the shared `_band`.

Worked critical: the processor test feeds five rows at a flat 12.10 V (`tests/test_processor.py(…)`) → EWMA = 12.10 < 12.2 → score 25 → critical. The cranking test (`tests/test_detectors.py(test_battery_cranking_critical)`) uses `rest = [(0.0, 12.6)]`, `crank = [(1.0, 9.0, 180.0)]`: one rest sample (≥5 required only when there is no crank), V_min 9.0 < 9.5 → score 20 → critical; `R_int = (12.6 − 9.0)/180·1000 = 20.0 mΩ` is 2.15× the 9.3 mΩ baseline, also over 1.5× → score 30, but 20 already binds.

### 3.7 Insufficient-data guard

`detectors.py(detect_battery)`:

```
if len(rest) < 5 and not crank:
    return DetectorResult(100, "healthy", {}, "Insufficient data — no alert.")
```

Fewer than five resting samples **and** no cranking data → hard `healthy` with score 100, no evidence, no reasons. Five is a magic number here (the minimum sample count for a meaningful EWMA/OLS fit, given the 10 % EWMA weight). The `< 5` test (`tests/test_detectors.py(test_battery_insufficient_data_no_alert)`) locks exactly this: three samples → healthy/100. Note the asymmetric composition: crank data bypasses the guard entirely (a single strong cranking event is enough to alert), and a `len(rest) ≥ 5` series with an empty crank list is analyzed normally.

### 3.8 Evidence dict fields

With resting data (`detectors.py(detect_battery)`):

```
{"ewma_voltage": "12.46", "slope_mv_day": "-6.67",
 "threshold_advisory": "12.4", "threshold_action": "12.2"}
```

All values are strings (the `PmMessage.evidence` proto map is `map<string, string>`, `pm-message.proto`), formatted to 2 decimals. Cranking-only (`ewma is None`):

```
{"cranking_only": "true", "threshold_advisory": "12.4", "threshold_action": "12.2"}
```

`cranking_only` is a string "true", not a boolean — again the proto map.

### 3.9 The explanation-template quirk

`detectors.py(detect_battery)`:

```python
explanation = ("Resting voltage {:.2f} V, drifting {:.2f} mV/day (advisory threshold {} V).".format(
    ewma, slope_mv_day, BATTERY_ADVISORY_V)) or ("; ".join(reasons) or "No anomaly.")
```

The f-string template is *always* truthy (a formatted string is never empty), so the `or` fallback to `reasons` is **dead code**: whenever resting data exists, the explanation is the fixed template — "Resting voltage 12.46 V, drifting -6.67 mV/day (advisory threshold 12.4 V)." — **regardless of which reasons fired** (action EWMA, slope, cranking). The accumulated `reasons` list is computed but never surfaced when `ewma is not None`; the action-threshold reason is dropped from the explanation even when it is the binding constraint. The cranking-only path (`ewma is None`) has no such quirk: `explanation = "; ".join(reasons) or "No anomaly."` really does join the crank reasons.

This is a live quirk in the current code (as of 2026-08-14), not a bug under test: `tests/test_detectors.py(test_battery_degrading_slope_advisory)` asserts `"12.4" in r.explanation` — which the template always satisfies, so the test passes even when the explanation hides the actual trigger. The design intent was evidently a fallback chain (template, else reasons, else "No anomaly"), but the template is never falsy.

---

## 4. Brake as implemented

### 4.1 Energy accumulation loop (Processor)

`processor.py(run)`, inside the row stream:

1. Only rows carrying **both** `dynamic:VELOCITY` and `dynamic:BRAKE_PEDAL_PCT` participate; the previous pair `(t, vel)` is remembered.
2. Braking is recognized when `brake_pct > 5.0` — matching the spec's "brake_pedal_pct > 5 %".
3. `dt = t − prev_t` is the **real sample spacing** between consecutive rows, with the comment "NOT the poll interval". This is a locked regression contract: `tests/test_processor_cadence.py` (both brake tests) proves that a 5 s-spaced pair of rows accumulates 131,250 J even when the poll interval is 60 s — the old poll-interval-inflated estimate saturated at 6 GJ and is explicitly regression-guarded.
4. `dt > 0` guards non-positive spacing; then deceleration and average velocity are estimated from the actual velocity delta:

```
a     = (vel − prev_v) / dt
v_avg = 0.5·(vel + prev_v)
```

5. Both gates must hold: `a < −0.5` m/s² **and** `v_avg > 0.5` m/s — the spec's deceleration and moving thresholds.
6. Accumulate:

```
brake_energy += VEHICLE_MASS_KG · |a| · v_avg · dt
```

with `VEHICLE_MASS_KG = 1500.0` (`processor.py(top)`). Since `a = Δv/Δt`, the `·dt` cancels: the increment is exactly `m·|Δv|·v_avg` — the trapezoidal rule over the velocity step, i.e. `∫ m·a·v dt` per tick with constant deceleration.

Why velocity-delta instead of an acceleration sensor? The processor comment states it plainly: the acceleration-modulus proto field is never persisted by the connector, so the only honest deceleration estimate available from stored telemetry is the finite difference of `VELOCITY` over the real sample spacing.

### 4.2 Budget and clamp

`processor.py(run)`:

```
results["brake"] = detect_brake(min(1.0, brake_energy / BRAKE_ENERGY_BUDGET_J))
```

The wear fraction is `E / 6e9` clamped to `[0, 1]` — energy above the budget reads as 1.0, never more (the simulator clamps identically in `brakeWearFraction`, `main.go(brakeWearFraction)`). Note the guard: the brake detector only runs when `brake_energy > 0` — no braking telemetry, no brake result at all (the component is absent from the published set, not "healthy").

### 4.3 detect_brake scoring and evidence

`detectors.py(detect_brake)`:

```
score = max(0, min(100, round(100·(1 − wear_fraction))))
severity: wear_fraction > 0.9 → action; > 0.8 → advisory; else healthy
```

The score is literally `100·(1 − wear)`, rounded, clamped — the spec's "brake = 100 − wear%". Severity mapping: **> 0.9 action, > 0.8 advisory, else healthy** (`BRAKE_ACTION = 0.9`, `BRAKE_ADVISORY = 0.8` at `detectors.py(top)`). Note this is the *only* detector whose severity comes from wear thresholds directly rather than the score band: a wear of 0.85 gives score 15 → the band would say action, but the explicit branch says advisory.

Evidence:

```
{"wear_fraction": "0.875", "wear_rate_per_km": "0.000000"}
```

`wear_rate_per_km` is **not wired**: the optional parameter `wear_rate_per_km=None` (`detectors.py(detect_brake)`) is never passed by the processor or evaluator, and the evidence field renders `wear_rate_per_km or 0` — always `0.000000`. The spec's RUL formula `RUL_km = (E_budget − W_accum)/wear_rate_km` therefore cannot be computed; the implementation is a wear-fraction detector only, no rate, no RUL.

Worked (locked by tests): two rows 5 s apart, 20 → 15 m/s (a = −1 m/s²), brake_pct 40 → per-tick energy `1500·|−1|·17.5·5 = 131,250 J` (`tests/test_processor_cadence.py(…)`); with a shrunken budget of 150,000 J the wear is `131250/150000 = 0.875` → advisory, evidence `"wear_fraction": "0.875"`.

---

## 5. Tires as implemented

### 5.1 Data collection (Processor)

Rows with **both** `dynamic:TIRE_PRESSURE` and `dynamic:TIRE_TEMP` are collected as `(t, P_bar, T_kelvin)` triples — the temp is converted to Kelvin at collection time by adding 273.15 (`processor.py(run)`). No steady-driving filter exists: the spec's "sample only at steady driving (v > 10 m/s, > 5 min, small |dv/dt|)" is not implemented; every row that carries both fields is fed to the detector, including idle/idle-adjacent rows. The evaluator collects identically (`evaluate_detectors.py(run_detectors_for_vin)`).

### 5.2 Compensation

`detectors.py(detect_tires)`:

```
comp = [(t, P·TIRE_REF_K / T) for each sample with T > 0],  TIRE_REF_K = 293.15
```

Ideal-gas normalization to 20 °C (`detectors.py(top)`). The `tk > 0` guard drops Kelvin-invalid samples (a 0 K row is physically impossible but arithmetically catastrophic). Worked (test-locked): 2.3 bar at 30 °C (303.15 K) → `2.3·293.15/303.15 = 2.2241 bar` — the same number as the first-principles doc. The single-sample temp-compensation test (`tests/test_detectors.py(test_tires_temp_compensation)`) exercises this path.

### 5.3 OLS with x in months

`detectors.py(detect_tires)`:

```
n = len(comp);  if n < 14: return healthy/100 "Insufficient tire data."
xs = t/86400/30            # months
ys = P_comp
slope_bar_m = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²,  guard den == 0 → 0.0
```

The 14-sample guard is the tire analog of the battery's 5-sample guard: with fewer than 14 compensated samples the detector returns healthy/100 with the explanation "Insufficient tire data." — a hard no-alert. The x-axis is months (`t/86400.0/30.0`), so the slope comes out directly in bar/month, and the denominator guard again collapses to slope 0.0 (safe — above the −0.15 rule).

### 5.4 Floor, slope rule, scoring

`detectors.py(detect_tires)`:

| Rule | Penalty |
|---|---|
| `last_p < TIRE_FLOOR_BAR` (1.8 bar) | `score = min(score, 20)` |
| `slope_bar_m < TIRE_SLOPE_BAR_M` (−0.15 bar/month) | `score = min(score, 55)` |

`last_p` is the **last compensated pressure** (`comp[-1][1]`) — the floor rule is a current-value rule, not a trend rule. Severity: `"action" if score < 30 else _band(score)` — score 20 from the floor → action; score 55 from the slope alone → advisory; both → 20 → action. Evidence:

```
{"p_comp_bar": "2.224", "slope_bar_month": "-0.0861",
 "threshold_slope": "-0.15", "floor_bar": "1.8"}
```

Explanation is the joined reasons or "No tire anomaly detected." — no template quirk here.

Worked (test-locked): 2.30 → 1.75 bar linear over 30 days at 303.15 K (`tests/test_detectors.py(test_tires_slow_leak_slope_advisory)`). After compensation the series runs 2.224 → 1.693 bar, last = 1.71 < 1.8 → score 20 → action; the compensated slope is −0.532 bar/month (well below −0.15, but the floor already binds). The test asserts `action`.

---

## 6. Simulator ground truth

### 6.1 Battery curves

`degradation.go(BatteryAt)`:

```
deg    = severityFactor() · √(norm(day))
vRest  = 12.63 − 0.63·deg      → 12.0 V at deg = 1
rInt   = 9.3 + 6.0·deg  mΩ     → 15.3 mΩ at deg = 1
vMin   = 10.8 − 1.3·deg  V     → 9.5 V at deg = 1
```

with `norm(day) = clamp(day/HorizonDays, 0, 1)` (`degradation.go(norm)`, default horizon 120) and `severityFactor` ∈ {0, 0.85, 1.0} (`degradation.go(severityFactor)`). The √-shape is the PyBaMM-informed aging curve — fast early sulfation that plateaus, then drops as `deg` saturates. The three full-degradation endpoints (12.0 V, 15.3 mΩ, 9.5 V) line up exactly with the detector's alert lines: the simulator's "dead battery" is the battery that hits `CRANK_VMIN` (9.5 V) and the R_int multiplier, and its resting voltage sits well under `BATTERY_ACTION_V`.

**Death collapse** (`degradation.go(BatteryAt)`, beyond the horizon): a real battery doesn't plateau at 12.0 V — once it can't hold charge it falls off a cliff and stops starting the car. For `day > HorizonDays` and a non-healthy preset:

```
f     = 1 − exp(−(day − HorizonDays)/7)     # 0 → 1 over ~3 sim weeks
vRest −= 1.5·f                              # 12.0 → 10.5 V dead cell
vMin  −= 2.5·f                              # cranking can no longer turn the starter
rInt  += 15.0·f                             # 15.3 → ~30 mΩ internal resistance
```

The collapse only applies when `severityFactor() > 0` — healthy batteries hold the plateau forever (the "healthy publishes nothing" contract). The 7-day time constant means the death arc is watchable in a demo: the battery crosses the 12.2 V action line at the horizon, then visibly dives to ~10.5 V over the next couple of minutes of fast-demo time, staying well below every detector threshold so severity saturates at critical.

Worked: degrading preset (0.85), horizon 120, day 60 → `deg = 0.85·√0.5 = 0.601`; `vRest = 12.63 − 0.63·0.601 = 12.251 V`; `vMin = 10.8 − 1.3·0.601 = 10.019 V`; `rInt = 9.3 + 6.0·0.601 = 12.91 mΩ`. Critical preset, day 60 of horizon 60 → `deg = 1.0`; `vRest = 12.0 V`. Same battery at day 74 (14 days past horizon): `f = 1 − e^−2 = 0.865`, `vRest = 12.0 − 1.5·0.865 = 10.70 V`, `rInt = 15.3 + 15·0.865 = 28.3 mΩ` — a dead cell that would never crank.

The publish loop ages the battery by `intervalSeconds/86400 · speed · degradationAccel` days per tick (`main.go(publishOnce)`), adds ±0.025 V noise to `vRest`, and clamps voltage to [11.0, 14.5]. SoC is `85.5 − 30·(severityFactor·ageDays/120)` floored at 5 — a linear proxy that the processor never reads (see §8.3). Battery temp reuses the tire temperature cycle (`main.go(publishOnce)`).

### 6.2 Tire curves — the three-phase death

`degradation.go(TirePressureAt)` / `degradation.go(TireTempAt)`:

```
Phase 1 — slow puncture:  2.3 − leakRate·day,  leakRate = 0.2·severityFactor/30 bar/day
                           (the spec's linear 0.2 bar/month leak) until P = 1.9 bar
Phase 2 — flex acceleration: 1.9 − 2·leakRate·(day − floorDay)
                           underinflated sidewalls flex + heat up, doubling the leak,
                           until the 1.2 bar structural floor
Phase 3 — structural collapse: 1.2 − 0.2·(1 − exp(−(day − collapseDay)/7))
                           the carcass is destroyed; pressure decays to the
                           ~1.0 bar "flat tire" asymptote — the whole tyre is useless
TireTempAt: 28 + 8·sin(day·2π) °C ambient; below 1.9 bar add flex heat
            clamp((1.9 − P)·20, 0, 14) °C — +2 °C per 0.1 bar underinflation
```

Healthy VINs return a flat 2.3 bar and ambient temp (they must publish nothing, so no leak, no heat). The self-acceleration is the physical story: the leak drops pressure, the drop flexes the sidewalls, the flexing heats the tire, and the heat — via the detector's ideal-gas compensation `P_comp = P·293.15/T` — makes the *compensated* pressure decline even faster than the raw leak. Phase 2 starts at the 1.9 bar threshold (below the detector's 1.8 bar floor is reached mid-phase-2, so the floor rule fires while the tire is already self-accelerating); phase 3 crosses into the 1.0–1.2 bar range where the tire is structurally dead, well below `TIRE_FLOOR_BAR`, so severity saturates at action and stays there.

Worked (degrading, severityFactor 0.85): `leakRate = 0.00567 bar/day`; the 1.9 bar threshold is crossed at day 70.6; the 1.2 bar floor at day ~132; at day 160 (28 days into collapse) `f = 1 − e^−4 = 0.982`, `P = 1.2 − 0.196 = 1.004 bar`, flex heat `(1.9 − 1.004)·20 = 17.9 → clamped 14 °C` — a flat, hot tire. The critical preset (severityFactor 1.0, horizon 60) reaches the flat asymptote twice as fast.

Both values are published via `buildChassisReport` (`main.go(buildChassisReport)`): raw pressure `P(day)` and raw temp `T(day)` (which the processor converts to Kelvin). The flex heat rides the same `TIRE_TEMP` field the connector maps, so the detector's temperature compensation sees the full physics.

### 6.3 The realistic trip narrative (what a viewer watches)

The single-vehicle demo is a story, not just three drifting numbers. One VIN drives the Bangalore loop repeatedly while the simulated clock advances:

1. **Advisories first** — after the backfill seeds 30 days of history, the battery slope and the tire leak trend cross their advisory lines within a minute of live time; brake wear climbs lap over lap.
2. **Action band** — tire pressure crosses the 1.8 bar floor (phase 2 of the leak), the battery EWMA dips under 12.2 V, brake wear passes 80 %.
3. **Death** — the battery's death collapse dives it past 11 V (the dashboard's `days_to_failure` ground truth hits 0), the tire hits its ~1.0 bar flat asymptote with a +14 °C flex-heat signature, and the brake accumulator saturates its 6 GJ budget. Every component is now permanently critical — the "vehicle is scrap" ending, at which point **Reset demo** is the only way back (below).
### 6.4 Brake accumulator (simulator side)

`main.go(driveCycleStep)` (brake phase): during the brake phase, velocity decreases by `3.0·dt` m/s per step, `brakePct = clamp(20+rand·40, 0, 100)`, and — only when `brakePct > 5 && velocity > 0.5` —

```
s.brakeEnergyJ += speed · 1500.0 · |velocity − vStart| · 0.5·(vStart + velocity)
```

`m·|Δv|·v_avg` with the same 1500 kg mass and the same trapezoidal form the processor derives from stored rows — the comment states the algebraic identity explicitly: "algebraically identical to the processor's velocity-delta estimate (m·|Δv|·v_avg, mass 1500 kg), so detector and truth stay comparable." The `speed` factor is the demo fast-forward multiplier: energy (and distance) scale with simulated time while the published velocity/sensor values stay at normal scale. The ground-truth wear fraction is `clamp(E/6e9, 0, 1)` (`main.go(brakeWearFraction)`) — the same clamp the processor applies.

### 6.5 Presets, demo fleet spread, backfill

- **Presets**: `severityFactor` 0 (healthy) / 0.85 (degrading) / 1.0 (critical) (`degradation.go(severityFactor)`); horizons 120 days, or 60 days for critical (`main.go(defaultDegradationConfig)`).
- **Demo fleet spread** (`DEGRADATION_PRESET=demo`, the default) in `main.go(defaultDegradationConfig)`: pool index < 0 (no pool) → healthy; odd pool index → healthy; pool index 0 → critical; otherwise → degrading. So a 20-VIN pool looks like: VIN0 critical, odd indices healthy, even indices ≥2 degrading. `poolIndex` is the index in the `VIN_POOL` env list (`main.go(poolIndex)`). The critical VIN is the "hero" that alerts within a poll cycle; the degrading VINs trend visibly.
- **Backfill** (`main.go(PublishTelemetryContinuously)`): a fresh stack has no telemetry history, so a 30-day-window detector would stay silent for days. Before the live loop, the sim advances the battery age by one simulated day per row (30 rows default, `BACKFILL_DAYS` env), publishes a battery + tire sample per day with timestamps `now − (backfillDays−i)·24h`, then enters live publishing. The drive cycle is deliberately NOT stepped at day scale ("velocity math would explode"); brake ground truth only accrues live. The result is that the detector's 30-day window fills with ~30 daily rows at startup and the slope rules fire immediately.

### 6.6 Ground truth labels

`main.go(groundTruth)` computes, from the same curves the telemetry walks:

- **battery**: `wear = clamp((12.63 − vRest)/0.63, 0, 1)` (fraction of the full 0.63 V decline, clamped — the death collapse drives `vRest` below 12.0 V and a dead battery is 100 % worn, never 123 %) and `days_to_failure = (1 − norm(ageDays))·HorizonDays`, forced to 0 past the horizon (the death collapse means failure has already happened).
- **brake**: `wear_fraction = round(brakeWearFraction, 3)` and `energy_joules = int64(brakeEnergyJ)`.
- **tires**: `pressure_bar = round(P(ageDays), 2)`, `temp_c = round(T(ageDays), 1)`.

`main.go(writeGroundTruthLabels)` appends one JSONL object per VIN per tick — `{"vin", "t_epoch", battery{...}, brake{...}, tires{...}}` — to the `GROUND_TRUTH_LABELS` path (append-only, best-effort, never fatal). The status-reply ground truth is the same `groundTruth` function.

---

## 7. Evaluator math (offline)

`evaluate_detectors.py(main)` re-runs the processor's poll + detectors over a configurable window (default `--soak-days 60`) with an explicit `TimeRange` instead of `last_duration` (`evaluate_detectors.py(run_detectors_for_vin)`), then compares alerts to labels.

### 7.1 Alert definition

An alert is any detector result with `severity != "healthy"` — the poll loop skips healthy results (`evaluate_detectors.py(run_detectors_for_vin)`). Note the contrast with the live service: the processor publishes *every* poll result healthy included (demo live-state cadence, `processor.py(run)`); the evaluator's alert list keeps only non-healthy. Each alert carries `{vin, component, health_score, severity, timestamp, t_epoch, evidence, explanation}`.

`active_pairs` — the set of `(vin, component)` that received any telemetry — is tracked but **not used in the metric math**: it is reported for context (VINs with data per component) and is a parameter of `compute_metrics` that the formula never reads. Recall's denominator is failed VINs, not active pairs (see below).

### 7.2 Failure definitions (ground truth)

`evaluate_detectors.py(collect_ground_truth)` parses the labels JSONL and marks a VIN+component **failed** the first tick its label crosses the failure line (`setdefault` keeps the first crossing epoch):

| Component | Failure condition |
|---|---|
| battery | `days_to_failure <= 0` (full degradation — 12.0 V resting) |
| tires | `pressure_bar <= TIRE_FLOOR_BAR` (1.8 bar) |
| brake | `energy_joules >= BRAKE_ENERGY_BUDGET_J` (6 GJ) |

These mirror the simulator's own ground truth. Missing labels file → empty dict, "scoring alerts only".

### 7.3 TP/FP/FN logic

`evaluate_detectors.py(compute_metrics)`, per component:

- `failed` = VINs with a failed label; `alerted` = VINs with ≥1 alert; `first_alert` = earliest `t_epoch` per alerting VIN.
- For each alerted VIN: TP when the VIN failed **and** `alert_epoch <= fail_epoch`; otherwise FP. A `None` alert epoch is un-datable → FP.
- `fn = len(failed − alerted)` — failures with no alert (or an alert after failure).
- Alert **after** failure = FP, not FN: the alerting VIN is in `alerted`, but the ordering test fails. The unit test `test_alert_after_failure_is_false_positive` locks this (`tests/test_evaluate.py`).

### 7.4 Precision / recall / mean lead days

```
precision      = TP / (TP + FP)
recall         = TP / (TP + FN)
mean_lead_days = mean over TPs of (fail_epoch − alert_epoch)/86400
```

Rounded to 3 decimals for the rates, 1 decimal for lead days. Only the first alert per VIN+component contributes lead (locked by `test_first_alert_wins_for_lead_time`). A component with neither failures nor alerts reports `None` and is written as JSON `null` — the "not measured" card, not a meaningless 1.0/0.0 (`test_unmodeled_component_reports_none`).

### 7.5 First-alert-epoch heuristics

`evaluate_detectors.py(_first_alert_epoch)` approximates *when* each VIN's alert would first have fired, for lead-time math:

- **battery**: first **temperature-compensated** sample `≤ BATTERY_ADVISORY_V` (12.4 V) — `v_comp = v_raw − BATTERY_BETA·(t0 − BATTERY_V_REF)`, the same compensation the detector consumes, not the raw reading. Note it uses the advisory line, not the action line, even if the alert itself was action/critical: the heuristic is "first sample the detector *would have* flagged as below advisory".
- **tires**: first compensated sample `≤ TIRE_FLOOR_BAR` (1.8 bar) — `p_comp = p·TIRE_REF_K/tk`.
- **brake**: no per-sample crossing exists (energy accumulates over the whole window), so the fallback is the **window start** — explicitly a **lower bound** on lead time. Naive (tz-stripped) window starts are interpreted as UTC before conversion so the epoch matches the UTC-aware sample timestamps.
- If no window is given: last rest/tire sample, else 0.0; non-battery/tires/brake → None.

A None here is impossible for a real alert (brake always has the window fallback; battery/tires scan the raw series the alert came from), but `compute_metrics` still guards it — a regression locked by `test_first_alert_epoch_brake_never_none`.

---

## 8. Design intent and known algorithm gaps

### 8.1 Detector and simulator share algebraically identical formulas — honest validation

The strongest design property of this prototype is that the detector and the ground truth are **the same math**, by construction:

| Quantity | Detector side | Simulator side |
|---|---|---|
| Brake energy | `m·|a|·v_avg·dt` with `a = Δv/Δt` → `m·|Δv|·v_avg` (`processor.py(run)`) | `m·|Δv|·v_avg` (`main.go(driveCycleStep)`) |
| Brake budget | 6 GJ (`processor.py(top)`) | 6 GJ (`degradation.go(top)`) |
| Wear clamp | `min(1, E/E_budget)` (`processor.py(run)`) | `clamp(E/E_budget, 0, 1)` (`main.go(brakeWearFraction)`) |
| V_rest curve | detector threshold 12.4/12.2 V (`detectors.py(top)`) | sim endpoints 12.0 V (`degradation.go(BatteryAt)`) |
| Tire compensation | `P·293.15/T` (`detectors.py(detect_tires)`) | temp cycle feeding raw `P` (`degradation.go(TireTempAt)`) |

This is deliberate and documented in comments on both sides ("algebraically identical… so detector and truth stay comparable" — `main.go(driveCycleStep)`; "Kept in sync with Processor.BRAKE_ENERGY_BUDGET_J so the evaluator reproduces the service's wear estimate exactly" — `evaluate_detectors.py(top)`). The honest framing matters: because the sim is the source of the "truth", high precision/recall scores are **circular evidence** — they prove the detector reproduces the formulas, not that the formulas predict real fleet failures. The validation card's value is (a) catching *implementation* divergence (regression guards like the poll-interval finding are exactly this) and (b) demonstrating the alert timeline (lead time before failure) under controlled trajectories.

## 8.7 End-to-end data flow (who reads what, in order)

```mermaid
flowchart LR
  subgraph Vehicle["vehicle-simulator (sample-clients/vehicle-client)"]
    DRV[driveCycleStep:<br/>velocity · brake energy · route]
    BAT[BatteryAt / TirePressureAt /<br/>TireTempAt curves]
    GT[groundTruth:<br/>wear + days_to_failure]
  end
  DRV --> PAY[buildPayloads]
  BAT --> PAY
  PAY -->|"telemetry.{VIN} · telemetry-generic.{VIN}.{sensor}"| NATS[(NATS)]
  NATS -->|auth-callout JWT perms| CONN[nats-bigtable-connector]
  CONN --> BT[(Bigtable telemetry<br/>row {VIN}#{RFC3339Nano})]
  BT --> API[data-api gRPC<br/>server-streaming]
  API -->|"poll 30-day window"| PM[predictive-maintenance<br/>Processor.run]
  PM --> DET[detectors.py:<br/>detect_battery · detect_brake · detect_tires]
  DET --> PUB{publish pm.{VIN}.{component}}
  PUB -->|"pm.>"| NATS
  NATS -->|"SSE /api/pm/stream"| WEB[data-web-client<br/>/demo gauges · /pm console]
  GT -->|"status reply"| WEB
  DRV -.->|"control subject commands.{VIN}.demo"| CTL[controlState:<br/>start/stop/speed/reset/degradation]
  CTL -.-> DRV
  PUB -.->|"labels JSONL"| EVAL[scripts/evaluate_detectors.py<br/>precision/recall/lead-time]
  GT -.-> EVAL
```

The two paths worth tracing: **detection** (left-to-right, vehicle → Bigtable → data-api → detector → NATS → SSE → web) and **control** (bottom, the web's start/stop/speed/reset/degradation commands on `commands.{VIN}.demo` go straight to the simulator and mutate the curves the next tick walks). Ground truth flows on a side channel (status reply + labels file) so the detector never sees the answer key.

## 8.8 Fast demo mode — how the clock bends

The 1×/5×/20× toggle on /demo and /pm sends a `speed` control action; the simulator stores the multiplier (`controlState.speedMultiplier`, `main.go(speedMultiplier)`). What it scales, and — the load-bearing invariant — what it does **not**:

| Quantity | Effect at speed ×N | Why |
|---|---|---|
| Battery age | `ageDays += dt·speed·degradationAccel` per tick (`main.go(publishOnce)`) | the degradation curves are functions of *simulated* age; ×N ages the vehicle N× faster |
| Trip distance / laps | `tripDist += v·dt·speed` (`main.go(driveCycleStep)`) | the route/lap counter is distance-driven |
| Brake energy | `brakeEnergyJ += speed·m·\|Δv\|·v_avg` (`main.go(driveCycleStep)`) | wear accrues with distance, so it must scale with the fast-forward too |
| Published velocity, voltages, pressures, temps | **unscaled** — normal 1× values | the dashboard must show physically plausible numbers at all speeds; the detector's math (EWMA, OLS, thresholds) never sees a ×N artifact |

So "fast demo" means *time flows N× faster for everything that integrates over time*, while every instant value stays honest. That is exactly why the fast-forward multiplier appears only inside the accumulators (`ageDays`, `tripDist`, `brakeEnergyJ`) and never in the payload builders — a property the comments in both files state and the tests lock (brake energy test asserts the `speed`-scaled trapezoid).

Net effect at 20×: one wall-clock minute ages the vehicle 20 simulated minutes, a lap accrues every few seconds, and the battery/tire trajectories — whose horizons are 60–120 *simulated* days — stay slow enough to watch. `DEGRADATION_ACCEL` is a second, compose-level multiplier (default 1200 in the demo stack) that stretches the same curves further, letting a 1–3 minute showcase traverse the full advisory → action → death arc (§6.3).

## 8.9 Reset, clear alerts, and what each actually clears

Two distinct "reset" concepts exist, and the demo wires both:

| Control | Where | What it resets |
|---|---|---|
| `reset` action → `controlState.resetSimulation` (`main.go(resetSimulation)`) | simulator | battery age → 0, fresh drive cycle, brake accumulator → 0, published counter → 0, degradation horizons → preset defaults. Speed multiplier is **kept** (resetting the story shouldn't slow the demo). The reply carries the fresh state so the UI updates immediately. |
| Clear alerts (demo/pm pages) | web client | the accumulated `pm.*` list: `usePmMessages.clearAlerts()` empties the in-memory list and removes the `pmMessages` sessionStorage key atomically, so a reload after clearing starts empty instead of resurrecting stale alerts. The SSE stream keeps running — the detector publishes on severity change/band crossing, so after a clear the list stays empty until a component genuinely re-crosses a band. |

The /pm **Reset demo** button fires both: the simulator `reset` command, then `clearAlerts()` — so the vehicle and its alert history return to a consistent "healthy vehicle, empty feed" state. Without the alert clear, resetting the sim would leave the dead-battery alerts from before the reset on screen, which reads as a bug even though the underlying state is correct.

---


### 8.2 M2 cranking detector is dormant

`detect_battery`'s M2 branch is fully implemented (`detectors.py(detect_battery)`: `vmin < CRANK_VMIN` → 20, `R_int > 1.5×` baseline → 30, `r_int = (12.6 − vmin)/ic·1000`), and the cranking-only evidence path exists. But the **simulator never emits cranking events**: `driveCycleStep`'s idle phase never produces a starter event, `BatteryAt` computes `vMin` and `rInt` (`degradation.go(BatteryAt)`) but the publish loop discards them (`_ = vMin; _ = rInt`, `main.go(publishOnce)`), and the processor's `crank` list is always empty. Consequence: M2 can never fire end-to-end; the critical-severity path is only reachable through EWMA < 12.2 V (score 25 → critical). The M2 unit tests pass against direct calls (`tests/test_detectors.py(test_battery_cranking_critical)`) but nothing in the live pipeline exercises them.

### 8.3 SOC drift (15 % weight) unimplemented

The spec's composite health score weights were "60 % resting-voltage trend, 25 % cranking signature, 15 % SOC drift" (`2026-08-14-pm-algorithms-battery-first-principles.md` §3.3). The implementation has **no SOC term at all**: `detect_battery` computes EWMA + slope + cranking only; the processor deliberately does not even request `dynamic:battery.soc` (comment in `processor.py(run)`; locked by `test_processor_requests_only_existing_qualifiers`, which asserts `dynamic:battery.soc` is not in the request). The score is a min-of-caps composition, not a weighted sum — the 60/25/15 weights were never transcribed into code. The simulator does emit SoC (`main.go(publishOnce)`) but it is dead data for the PM pipeline.

### 8.4 Tire steady-driving filter unimplemented

The first-principles spec requires sampling only at steady driving (v > 10 m/s, > 5 min into trip, small |dv/dt|) to kill warm-up and transient noise. The processor collects every row that has both pressure and temp — no velocity gate, no trip-time gate, no rate-of-change gate. In practice the simulator's tire rows share rows with the brake/velocity fields, and the ±8 °C daily temp cycle (compensated out by the ideal-gas normalization) plus the ±0.1 bar chassis noise (`main.go(buildChassisReport)`: healthy chassis reports `2.2 ± 0.05` bar, `28 ± 0.25` °C) are the main noise sources the slope fit must survive. The 14-sample guard and the OLS averaging are the only mitigation.

### 8.5 Battery explanation-template quirk

Described in §3.9: when resting data exists, the explanation is always the fixed "Resting voltage …, drifting … mV/day (advisory threshold 12.4 V)." template; the `or ("; ".join(reasons) …)` fallback is dead because a formatted string is never falsy. The `reasons` list — which holds the *actual* triggers (action EWMA, slope, cranking) — is discarded. Live consequence: an action-EWMA battery (12.1 V) explains itself as drifting past the *advisory* threshold, and a slope-only alert's explanation hides the slope. The cranking-only path is unaffected. This is the one place where the implementation's explanation output diverges from its own evidence dict, and the current unit test (`"12.4" in r.explanation`) happens to lock the template in.

### 8.6 Other deltas worth naming (as-implemented vs spec)

- **Publish cadence**: the spec says publish on severity change; the current processor publishes every poll, healthy included, with an explicit comment that this was changed for the live board (`processor.py(run)`). This is operational behavior, not algorithm — but it changes what the evaluator's alert filter (`severity != healthy`) is doing: it reconstructs the spec's cadence from the service's always-on stream.
- **Brake `wear_rate_per_km`** is a placeholder 0 (see §4.3) — no RUL in the current build.
- **`recommended_bar=2.3`** (`detectors.py(detect_tires)`) is accepted but never used by the detector body (the floor and slope rules don't reference it) — the spec's "linear 100→0 as P falls from recommended to floor" score was implemented as the two min-caps instead.
- **`Processor._band_of`** (`processor.py(_band_of)`) exists but is not called by `run` — severity is computed inside the detectors (`_band`, `detectors.py(_band)`); the method is currently dead code.

---

## 9. Repo grounding (files + key functions)

- `sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py` — all detector constants (`(top)`), `_band`, `detect_battery`, `detect_brake`, `detect_tires`
- `sample-services/predictive-maintenance/src/predictive_maintenance/core/processor.py` — `BRAKE_ENERGY_BUDGET_J`/`VEHICLE_MASS_KG` (`(top)`), `run` (poll request + collection + compensation + detection dispatch + publish loop), `_band_of`
- `sample-services/predictive-maintenance/src/predictive_maintenance/config/config.py` — `poll_interval_seconds`, `battery_window_days` (`(top)`)
- `sample-services/predictive-maintenance/src/predictive_maintenance/model/pm_message.py` — generated `PmMessage` (evidence as `map<string,string>`)
- `sample-clients/vehicle-client/degradation.go` — `brakeEnergyBudgetJ` (`(top)`), `norm`, `severityFactor`, `BatteryAt`, `TirePressureAt`, `TireTempAt`
- `sample-clients/vehicle-client/main.go` — `poolIndex`, `driveCycleStep` (brake phase + accumulator), `brakeWearFraction`, `buildChassisReport`, `groundTruth`, `writeGroundTruthLabels`, `defaultDegradationConfig`, `publishOnce` (battery aging + publish), `PublishTelemetryContinuously` (backfill + live loop)
- `sample-services/predictive-maintenance/scripts/evaluate_detectors.py` — mirrored constants (`(top)`), `run_detectors_for_vin` (poll loop + compensation), `_first_alert_epoch`, `collect_ground_truth`, `compute_metrics`, `write_validation_json`, `main`
- `sample-services/predictive-maintenance/tests/test_detectors.py`, `tests/test_processor.py`, `tests/test_processor_cadence.py`, `tests/test_evaluate.py` — locked contracts cited inline above
- Protobuf schema: `proto/vehicle_telemetry.proto` (all `VehicleTelemetryData` fields incl. `CarlaVehicleDynamics`), `proto/telemetry.proto` (`TelemetryMessage`/`SensorReading`), `proto/pm-message.proto` (`PmMessage`)
- Design/spec anchors: `docs/superpowers/specs/2026-08-09-predictive-maintenance-prototype-design.md`, `docs/superpowers/research/2026-08-14-pm-algorithms-battery-first-principles.md`, `docs/superpowers/research/2026-08-14-pm-algorithms-brake-first-principles.md`, `docs/superpowers/research/2026-08-14-pm-algorithms-tires-first-principles.md`

---

## 10. Cross-links (companion first-principles docs)

- **Battery first principles** — why OCV ↔ SoH, why EWMA + OLS, the OCV→SoC table, β and the 30 °C India reference: `docs/superpowers/research/2026-08-14-pm-algorithms-battery-first-principles.md`
- **Brake first principles** — friction work, the energy integral, the 6 GJ budget derivation, the wear-rate RUL extension this build does not wire: `docs/superpowers/research/2026-08-14-pm-algorithms-brake-first-principles.md`
- **Tires first principles** — ideal-gas compensation, the 10 °C ≈ 0.08 bar sensitivity argument, steady-driving sampling rationale (currently unimplemented): `docs/superpowers/research/2026-08-14-pm-algorithms-tires-first-principles.md`

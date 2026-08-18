# Real Telemetry for Indian Vehicles — Signal Availability & Data-Acquisition Approaches

Date: 2026-08-18
Status: **Reference — what real Indian vehicles can (and cannot) give us, and the honest paths to get the telemetry the PM detectors need.**
Audience: engineers deciding how to validate the predictive-maintenance detectors on real Indian vehicles instead of the simulator.

> Context: the PM detectors predict three component failures — 12 V battery
> (resting-OCV trend + cranking sag), per-wheel tire pressure (slow leak),
> and brake-pad wear (friction energy). The simulator generates all three
> signals with known ground truth, but the validation is **circular** (the
> simulator uses the same formulas as the detector). Real data breaks the
> circle. This doc records *what real Indian vehicles actually expose* and
> *how to get it*, so the limitation and the plan are explicit, not implicit.

---

## 1. The core limitation — what stock Indian cars expose

The three signals the detectors need are **not uniformly available** from a
stock Indian passenger car. The single most important fact:

> **OBD-II gives engine data, not component-health data.** The three PM
> signals live outside the OBD-II PID set.

### 1.1 What the mandatory OBD-II port (BS6 Phase 2, since April 2020) gives you — free

Every Indian car has an OBD-II port. Standard PIDs (SAE J1979) yield:

| Signal | PID | Detector use |
|---|---|---|
| Speed | 0x0D | Brake energy (`m·a·v`) ✓ |
| RPM, coolant temp, MAF, distance | standard | Context / duty cycle |
| Control-module voltage | 0x42 | Battery voltage — **noisy** (system/alternator voltage, not resting OCV) |

**Consequence:** the **brake-wear detector is runnable on a stock Indian car**
today (ELM327 + speed logging → velocity-delta energy integral). The battery
and tire detectors are not, for the reasons below.

### 1.2 What stock cars do NOT expose (the actual gaps)

| PM signal | Availability on latest Indian models (checked 2026-08) | Why |
|---|---|---|
| **Clean resting battery voltage (OCV)** | ❌ Not cleanly | OBD PID 42 is system voltage, polluted by alternator + load. The detector's EWMA needs an engine-off, unloaded OCV. |
| **Per-wheel tire pressure** | ❌ Not available | TATA Punch ships **indirect iTPMS** (ABS wheel-speed comparison — detects a *relative* drop, reports **no pressure values**). TATA Safari has **no TPMS** (removed from variants). |
| **Brake pad wear** | ❌ Not available | No OEM at this price tier ships a pad-wear sensor; it is universally estimated, not measured. |

### 1.3 The TATA iRA connected platform — partial, not a research path

TATA's iRA 2.0 / iRA.ev collects vehicle status + basic "live diagnosis" in
the cloud. Two findings:

1. **No official developer/API program.** Access is per-owner via the mobile
   app. A community wrapper exists (`ira-ev-api-wrapper` on PyPI) that hits the
   *undocumented* iRA.ev HTTP API (login → refresh token → vehicle details),
   which proves the data is reachable but is **undocumented, ToS-violating,
   and per-VIN-scoped** — unsuitable as a research or product foundation.
2. **Data scope is limited** to vehicle status (doors/locks/charge/location) +
   basic diagnostics — it does **not** expose per-wheel pressure (indirect TPMS
   is computed, not sensed) or pad wear.

---

## 2. What we can actually do — approaches, ranked by leverage

### Approach A — Instrument a small pilot fleet (the honest, self-serve path)

Add the **missing sensors** to the repo's existing ESP32 `iot-client` (which
already does GPS + NATS + mTLS auth). Each signal needs a cheap, off-the-shelf
component, readable on the ESP32's ADC/I2C/1-Wire/BLE:

| PM signal | Sensor | ~Cost | Read method | Notes |
|---|---|---|---|---|
| Resting battery voltage | 12 V divider or INA219 | ₹50–300 | ADC / I2C | Direct rail tap — clean OCV when parked; add ignition gate |
| Battery temp | DS18B20 | ₹100 | 1-Wire | For β compensation |
| Per-wheel tire pressure | 4× aftermarket BLE TPMS valve caps | ₹2–3K/set | BLE → ESP32 gateway | Gives real `TIRE_PRESSURE.{FL,FR,RL,RR}` |
| Brake energy (velocity) | OBD-II ELM327 (speed) or GPS | ₹300 | UART / GPS | Stock port; feeds the energy integral |
| **Ground truth (battery)** | Conductance tester (CCA / IR / SOH) | ₹3–16K | Manual, periodic | The commercial instrument for validating the battery detector |

**Why this is the right R&D path:** it captures the *exact* signals the
detector code consumes, with known ground truth — which breaks the circular
validation. Instrument 2–3 real vehicles, log for weeks, pipe the same
NATS/Bigtable pipeline.

### Approach B — Partner with an AIS-140 telematics vendor (the scale path)

India mandates AIS-140 Vehicle Location Tracking Devices on commercial
vehicles (public transport + commercial fleets, enforced ~March 2026). These
vendors (Fleetx, LocoNav, Intangles, Zeliot, Smart Telematics) already have
deployed hardware streaming GPS/speed/ignition over cellular. The value:

- **Ignition state** — the missing gate for battery resting-OCV extraction.
- **Real Indian duty cycles** — the calibration data the 6 GJ brake budget
  needs.
- **Scale** — hundreds of vehicles, not three.

**Confirmed:** LocoNav publishes **public developer APIs**
(`developers.loconav.com` — REST + webhooks covering telematics, diagnostics,
safety). This is a legitimate integration point, not a reverse-engineering
hack. The play: propose a research collaboration — "give us anonymized
historical telemetry + let us add 2 sensors (battery voltage, TPMS) to N pilot
vehicles, and we build the PM detector on your AIS-140 stream."

### Approach C — OBD-II logger on a personal/fleet car (immediate, partial)

A ₹300 ELM327 + Torque/ESP32 logs RPM/speed/coolant/control-module-voltage.
Validates the **brake energy** path (velocity integral) and gives a rough
**battery voltage** series (noisy — needs ignition gating + parking logic to
approximate OCV). No tire pressure. Good for pipeline plumbing + brake-budget
calibration; insufficient alone.

### Approach D — Open Indian datasets (behavioral context only)

| Dataset | What it is | PM use |
|---|---|---|
| India Driving Dataset (IDD), IIIT-Hyderabad | Open camera/video | ❌ Not PM telemetry — only velocity/duty-cycle context |
| INSAAN (IIIT) | Driving-behavior video | ❌ Same |
| ARAI IVT CoE | Camera/LiDAR/radar (ADAS) | ❌ Not component health |

**None carry battery/tire/brake health data.** They model Indian *driving
behavior*, not the degradation signals. Useful only to calibrate the velocity/
duty-cycle side, never to validate the detectors.

---

## 3. The strategic conclusion

For the three signals the PM system predicts, **no open "Indian vehicle
telemetry dataset" exists** — commercial fleets treat it as proprietary. So the
choice is:

1. **Instrument ourselves** (Approach A) — the only way to get per-wheel
   pressure + clean battery OCV without a partnership. A weekend of work given
   the `iot-client` already handles the transport.
2. **Partner** (Approach B) — LocoNav's public API + an AIS-140 vendor's
   ignition/duty-cycle data is the production-scale path.
3. **Accept partial** (Approach C) — OBD-II alone covers brake energy + noisy
   battery voltage, missing the headline tire/pad signals.
4. **Behavioral context only** (Approach D) — open datasets do not solve the
   signal gap.

The reference implementation's honest next step is **Approach A at small
scale** (2–3 instrumented vehicles → non-circular validation) followed by
**Approach B** for production calibration.

---

## Sources

- OBD-II PIDs (SAE J1979) — https://en.wikipedia.org/wiki/OBD-II_PIDs
- BS6 Phase 2 / OBD-II mandate (India, April 2020) — https://www.tvsmotor.com/media/blog/bs6-phase-2-rde-and-obd-2-compliance-explained ; https://www.autocarpro.in/news-national/bs-vi-norms-mandate-board-diagnostics-vehicles-check-emissions-21822
- TATA iRA connected platform — https://www.spinny.com/blog/tata-ira-connected-car/ ; https://www.cars24.com/article/tata-ira-explained/
- TATA Safari TPMS absence — https://www.carbike360.com/car-faqs/does-tata-safari-come-with-a-tyre-pressure-monitoring-system-4
- TATA Punch indirect iTPMS — Punch MY23 manual supplement (iTPMS, ABS wheel-speed based)
- iRA.ev community API wrapper (undocumented, ToS caveat) — https://pypi.org/project/ira-ev-api-wrapper/
- LocoNav public developer APIs — https://developers.loconav.com/
- Battery conductance testers (CCA/IR/SOH, ₹3–16K) — Amazon.in / Flipkart / Indiamart listings (Magnyte BM550, FNIRSI BTM-24, amiciSense, HTC BM-36)
- ESP32 OBD-II / CAN logging precedent — https://github.com/roypeter/esp32-obd2-logger ; https://github.com/Abroh2005/OBD-II-Port-Telemetry-ADAS-ESP32
- India Driving Dataset (IDD) — https://blogs.iiit.ac.in/idd-dataset/

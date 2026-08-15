# Runtime VIN Switching + Per-Wheel/Pad PM Modeling — Design

Date: 2026-08-15
Status: Approved (verbal) — being implemented

## Problem

1. The local demo runs ONE simulator bound to ONE VIN for its whole life. The web
   presents a 10-VIN fleet with per-VIN Start/Stop, but selecting another VIN +
   Start always runs the same vehicle: the sim only subscribes
   `commands.<bootVIN>.demo`, the web publishes to `commands.<selectedVIN>.demo`,
   nobody listens, discovery re-probes and finds the same sim VIN.
2. Tires and brakes are modeled as ONE channel per vehicle, so asymmetric
   failures (LF tire flat, RR pad worn) are invisible. A PM system should track
   per-component-instance degradation.

## Design

### Part 1 — Runtime VIN switching

- **Sim** (`sample-clients/vehicle-client/main.go`):
  - Subscribe `commands.>.demo` (wildcard) instead of `commands.<bootVIN>.demo`.
  - On `start` with `req.Vin` present: **adopt** that VIN — swap the active VIN
    under lock, reseed degradation curves for the new VIN, zero `batteryAgeDays`,
    clear drive/route state. Status replies echo the adopted VIN.
  - Publish subjects already read the active VIN dynamically (`v.VIN`), so they
    repoint automatically.
- **Auth** (`base-services/auth-callout/main.go`): add `DEMO_MODE` env; when set,
  grant broad perms `telemetry.>`, `telemetry-generic.>`, `commands.>`,
  `_INBOX.>` so the sim may publish/subscribe any VIN. Production (unset) keeps
  per-VIN isolation. Local compose sets `DEMO_MODE=true` for auth-callout.
- **Web**: no change to start/discover targeting (already sends `vin` on start).
  Discovery re-probes the pool; when it finds a NEW sim VIN (adopted), the PM
  page clears the previous VIN's state (see Part 2).

### Part 2 — Per-wheel / per-pad modeling

- **Sensor naming contract** (proto + sim + connector + detector + web):
  - Tires: `TIRE_PRESSURE.FL`, `TIRE_PRESSURE.FR`, `TIRE_PRESSURE.RL`,
    `TIRE_PRESSURE.RR`; `TIRE_TEMP.FL`, `TIRE_TEMP.FR`, `TIRE_TEMP.RL`,
    `TIRE_TEMP.RR`.
  - Brakes: `BRAKE_WEAR.FL`, `BRAKE_WEAR.FR`, `BRAKE_WEAR.RL`, `BRAKE_WEAR.RR`
    (fraction 0..1 of pad life consumed; the sim publishes per-pad wear
    derived from a per-pad energy share of the existing brake-energy budget).
- **Sim** (`degradation.go`): 4 independent tire curves with staggered failure
  (e.g. FL fails first) + 4 per-pad brake wear accumulators. Publish per-wheel
  sensors. Ground-truth reply gains `tires: {fl: {pressure_bar, temp_c}, ...}`
  and `brakes: {fl: wear_fraction, ...}`.
- **Connector** (`nats-bigtable-connector`): maps `dynamic:TIRE_PRESSURE.FL` etc.
  as columns automatically (already generic per-sensor). Verify no hardcoded
  sensor list.
- **Detector** (`processor.py` + `detectors.py`): request per-wheel columns;
  run `detect_tires` ×4 and `detect_brake` ×4; publish `pm.{VIN}.tires.{wheel}`
  and `pm.{VIN}.brake.{pad}`; add `wheel`/`pad` to evidence.
- **Web**:
  - `pm-types.ts`: `component: 'tires' | 'brake' | 'battery'` + `wheel`/`pad`
    field from the 4th subject token.
  - `pm-health.ts`: parse per-wheel; compute worst-wheel aggregate for the main
    badge (min score drives severity), per-wheel entries for detail.
  - `pm-charts.tsx`: expand dialog shows per-wheel/pad rows; main card shows
    worst-wheel summary; **clear all PM/chart state when the sim VIN changes**
    (no stale graphs from the previous VIN).

### Data/UI cleanup on VIN switch (explicit requirement)

- The web tracks the "current sim VIN" from discovery. When it changes:
  - Clear the PM message map, health map, and chart buffers.
  - Clear the demo telemetry buffers for the old VIN.
  - Show the new VIN's data only. This is the "clear up data and graphs for past
    VIN at time of switch" requirement.

## Contracts (shared by all parallel agents)

1. **Sensor names**: `TIRE_PRESSURE.{FL,FR,RL,RR}`, `TIRE_TEMP.{FL,FR,RL,RR}`,
   `BRAKE_WEAR.{FL,FR,RL,RR}` — connector maps to `dynamic:<name>` columns.
2. **PM subjects**: `pm.{VIN}.tires.{wheel}`, `pm.{VIN}.brake.{pad}`,
   `pm.{VIN}.battery` (unchanged). Web parses the 4th token as wheel/pad.
3. **Ground truth**: sim reply gains `tires.{wheel}.pressure_bar/.temp_c` and
   `brakes.{wheel}.wear_fraction`.
4. **Auth**: `DEMO_MODE=true` on auth-callout grants broad NATS perms; unset
   keeps per-VIN isolation. Sim subscribes `commands.>.demo`.
5. **Continuous health meters** (from the detector fix already merged): scores
   are continuous in the signal (voltage 12.63→10.5 V = 100→0, pressure
   2.3→0.9 bar = 100→0), severity from thresholds.

## Out of scope (this session)

- Full per-wheel proto fields (typed proto fields for each wheel) — using the
  existing generic sensor-path (`dynamic:...`) for now.
- Multi-simulator concurrency (N containers). Single sim, VIN adoption only.

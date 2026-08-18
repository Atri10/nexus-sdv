# Sensor Catalog and Physical Meaning

The detector consumes a small subset of the vehicle schema. A field is useful
only when its physical meaning, unit, timestamp, and acquisition path are
known.

## PM input catalog

| Signal | Unit | Physical meaning | Produced by current simulator | Detector use |
|---|---:|---|---|---|
| `battery.voltage` | V | Battery terminal voltage; the detector treats it as resting voltage. | `BatteryAt` plus Gaussian noise; generic `SensorReading.value`. | Temperature compensation, EWMA, calendar-day slope. |
| `battery.temp` | °C | Temperature at the battery measurement point. | `BatteryTempAt` plus noise; generic reading. | Forward-filled battery compensation temperature. |
| `TIRE_PRESSURE.{wheel}` | bar | Inflation pressure at one wheel. | `TirePressureAt`; one generic message per wheel. | Convert to reference temperature and fit leak slope. |
| `TIRE_TEMP.{wheel}` | °C | Tire temperature at one wheel. | `TireTempAt`; one generic message per wheel. | Convert to Kelvin for pressure compensation. |
| `BRAKE_WEAR.{pad}` | fraction | Estimated consumed pad life, where 0 is new and 1 is exhausted. | `BrakeWearAt` from accumulated braking energy and pad bias. | Direct per-pad score and severity. |
| `VELOCITY` | m/s | Vehicle longitudinal speed. | `driveCycleStep`; typed chassis report. | Fallback brake energy: `Δv`, `v_avg`, and deceleration gate. |
| `BRAKE_PEDAL_PCT` | % | Brake-pedal position, not force or pad pressure. | Brake phase value, typed chassis report. | Fallback energy gate only (`> 5%`). |

## How values become detector samples

```mermaid
flowchart LR
    S["Raw sensor or simulator value"]
    U["Unit and encoding conversion"]
    T["Timestamped Data API point"]
    G["Processor grouping"]
    X["Detector sample tuple"]

    S --> U --> T --> G --> X
```

The generic path stores sensor values as strings/bytes. The processor decodes
them with `float(...decode().strip('"'))`. Tire temperatures receive `+273.15`
before detector use. Battery voltage receives temperature compensation before
it reaches `detect_battery`. The row timestamp—not the poll timestamp—is used
as the x-coordinate for trend calculations.

## Fields present but not consumed

The schema also defines battery current, battery state of charge, ignition,
acceleration, distance, engine, GPS, steering, and gear values. They are not
equivalent to detector inputs merely because they are persisted or displayed:

- `battery.current` is emitted by the simulator but no cranking series is
  assembled by the processor.
- `battery.soc` is emitted but not requested by the PM Data API query.
- `acceleration_modulus_m_s2` and `distance_meters` are not persisted by the
  connector path used by PM, so brake energy is reconstructed from velocity and
  distance-based wear rate is unavailable.
- `IGNITION_STATE` exists in the typed chassis message but is not used to prove
  that a voltage sample is unloaded/resting.

## Indian vehicle availability

This catalog describes detector requirements, not stock-vehicle guarantees.
OBD-II speed is a practical input for the fallback brake path. OBD-II
control-module voltage is not clean resting OCV, indirect TPMS may not expose
pressure values, and direct pad-wear sensing may be absent. See [Indian vehicle
telemetry availability](13-indian-vehicle-telemetry-availability.md).

## Sources

- [`telemetry.proto`](../../../../proto/telemetry.proto)
- [`vehicle_telemetry.proto`](../../../../proto/vehicle_telemetry.proto)
- [`processor.py`](../../../../sample-services/predictive-maintenance/src/predictive_maintenance/core/processor.py)
- [`main.go`](../../../../sample-clients/vehicle-client/main.go)
- [`2026-08-15-pm-use-case-end-to-end.md`](../../../../docs/superpowers/research/2026-08-15-pm-use-case-end-to-end.md)
- [`13-indian-vehicle-telemetry-availability.md`](13-indian-vehicle-telemetry-availability.md)

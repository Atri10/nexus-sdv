# Traceability Matrix

| Requirement or claim | Research basis | Current implementation | Output |
|---|---|---|---|
| Detect battery voltage deterioration | Battery OCV trend and temperature dependence | `processor.py` compensation → `detect_battery` EWMA and slope | `pm.{VIN}.battery` |
| Detect near-term battery starting risk | Cranking voltage and internal-resistance approach | Detector supports `V_min` and `I_crank`; live processor does not yet collect them | Battery evidence when cranking data is available |
| Detect per-wheel slow tire leaks | Ideal-gas pressure compensation; UNECE indirect-TPMS is future direction | `detect_tires` per wheel using pressure and temperature | `pm.{VIN}.tires.{wheel}` |
| Detect brake-pad wear | Friction-work/energy model and calibrated wear fraction | Per-pad `BRAKE_WEAR` primary path; velocity-energy fallback | `pm.{VIN}.brake.{pad}` or legacy `pm.{VIN}.brake` |
| Explain every result | Explainable deterministic detector design | `PmMessage.evidence` and `explanation` | Dashboard evidence and alert text |
| Stream results to consumers | NATS pub/sub and SSE integration | Web route subscribes to `pm.>` and emits SSE | `/demo` and `/pm` |
| Validate detector behavior | Simulator ground truth and offline replay | `evaluate_detectors.py` plus unit/integration tests | Precision, recall, lead time, test results |
| Validate on Indian vehicles | Availability and acquisition research | Instrumented pilot, OBD-II partial path, or telematics partnership | Non-circular real-vehicle evidence |

## Signal-level anchors

| Detector input | Message source | Stored qualifier | Processor transformation |
|---|---|---|---|
| Battery voltage | Generic `SensorReading(sensor=battery.voltage)` | `dynamic:battery.voltage` | Decode string; compensate with latest battery temperature. |
| Battery temperature | Generic `SensorReading(sensor=battery.temp)` | `dynamic:battery.temp` | Decode string; forward-fill in stream. |
| Wheel pressure | Generic `SensorReading(sensor=TIRE_PRESSURE.FL..RR)` | `dynamic:TIRE_PRESSURE.{wheel}` | Decode bar value; pair with same-wheel temperature. |
| Wheel temperature | Generic `SensorReading(sensor=TIRE_TEMP.FL..RR)` | `dynamic:TIRE_TEMP.{wheel}` | Decode °C; add 273.15 K. |
| Pad wear | Generic `SensorReading(sensor=BRAKE_WEAR.FL..RR)` | `dynamic:BRAKE_WEAR.{pad}` | Decode and clamp to 0–1; retain latest value. |
| Brake velocity fallback | Typed `VehicleTelemetryData.VELOCITY` | `dynamic:VELOCITY` | Use adjacent row timestamps to calculate `Δv/Δt`. |

## Primary implementation anchors

- [`detectors.py`](../../../../sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py)
- [`processor.py`](../../../../sample-services/predictive-maintenance/src/predictive_maintenance/core/processor.py)
- [`pm-message.proto`](../../../../sample-services/predictive-maintenance/proto/pm-message.proto)
- [`route.ts`](../../../../sample-clients/data-web-client/src/app/api/pm/stream/route.ts)
- [`evaluate_detectors.py`](../../../../sample-services/predictive-maintenance/scripts/evaluate_detectors.py)

# Research Sources

The repository's canonical external-source register is
[`2026-08-18-pm-algorithms-sources.md`](../../../../docs/superpowers/research/2026-08-18-pm-algorithms-sources.md).
The most relevant sources for the current algorithm pages are listed below.

## Battery

- [US20110082621A1](https://patents.google.com/patent/US20110082621A1/en) — combines open-circuit voltage, cranking voltage, temperature, and usage for battery-life prediction.
- [US11742681](https://patents.justia.com/patent/11742681) — vehicle battery health analysis using voltage and temperature telemetry and cranking internal-resistance framing.

## Tires

- [UNECE vehicle regulations — Regulation No. 64](https://unece.org/transport/vehicle-regulations) — indirect TPMS direction using relative wheel speed; documented as future work because the current schema lacks per-wheel speed.

## Deterministic detection architecture

- [AXIS: An EXplainable Anomaly Detection Framework for Time Series](https://arxiv.org/abs/2509.24378) — source listed by the repository for separating deterministic detection from optional LLM validation or narration.

## Calibration note

The source register classifies several constants as literature-typical or
physics-derived rather than fleet-calibrated. Those include battery voltage
temperature coefficient, OCV reference curve, brake energy budget, tire
permeation baseline, and temperature references. They must not be presented as
universal production thresholds.

## Indian vehicle telemetry availability

The repository's Indian-vehicle research is maintained in
[`2026-08-18-indian-vehicle-telemetry-availability.md`](../../../../docs/superpowers/research/2026-08-18-indian-vehicle-telemetry-availability.md).
Its source list includes OBD-II PID references, BS6 Phase 2 context, Tata
connected-platform references, the iRA community-wrapper caveat, LocoNav's
public developer API, ESP32 OBD-II examples, and the India Driving Dataset.
Those sources support feasibility and acquisition planning; they do not supply
independent battery, tire, or brake-health labels.

## Local research and implementation sources

- [`2026-08-14-pm-algorithms-battery-first-principles.md`](../../../../docs/superpowers/research/2026-08-14-pm-algorithms-battery-first-principles.md)
- [`2026-08-14-pm-algorithms-brake-first-principles.md`](../../../../docs/superpowers/research/2026-08-14-pm-algorithms-brake-first-principles.md)
- [`2026-08-14-pm-algorithms-tires-first-principles.md`](../../../../docs/superpowers/research/2026-08-14-pm-algorithms-tires-first-principles.md)
- [`2026-08-14-pm-algorithms-implementation.md`](../../../../docs/superpowers/research/2026-08-14-pm-algorithms-implementation.md)

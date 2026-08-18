# Predictive Maintenance Algorithms

This section explains the algorithms used to convert telemetry into component
health results. Each algorithm page covers the physical signal, the research
or engineering principle, the current implementation, pseudocode, thresholds,
and limitations.

The canonical list of external references is maintained in
[`2026-08-18-pm-algorithms-sources.md`](../../../superpowers/research/2026-08-18-pm-algorithms-sources.md).
Algorithm pages link to the specific external sources that support their
claims, as well as to the local code and research documents that define the
current implementation.

## Algorithm pages

- [12V battery health](01-battery-health.md)
- [Brake-pad wear](02-brake-pad-wear.md)
- [Tire health](03-tire-health.md)

All pages identify which behavior is implemented, which behavior is fallback
or future work, and which constants still require fleet calibration.

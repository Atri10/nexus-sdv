# Glossary

| Term | Meaning in this documentation |
|---|---|
| VIN | Vehicle identifier used in NATS subjects, storage row keys, and PM messages. |
| Telemetry | Time-stamped vehicle measurements or simulator-generated values. |
| EWMA | Exponentially weighted moving average used to smooth battery voltage. |
| OLS slope | Ordinary least-squares trend calculated over timestamped samples. |
| Compensated voltage | Battery voltage adjusted to the configured temperature reference. |
| Compensated pressure | Tire pressure adjusted to 20 °C using absolute temperature. |
| Wear fraction | Estimated consumed component life expressed from 0 to 1. |
| Health score | Continuous 0–100 condition meter. |
| Severity | Alert category: healthy, advisory, action, or critical. |
| Evidence | String key/value measurements and thresholds attached to a result. |
| Data API | gRPC service that streams telemetry points from Bigtable. |
| PM message | `PmMessage` protobuf published on `pm.*` NATS subjects. |
| Ground truth | Simulator or labeled reference state used to evaluate detector output. |
| Fallback path | Compatibility algorithm used when newer per-wheel/per-pad qualifiers are unavailable. |

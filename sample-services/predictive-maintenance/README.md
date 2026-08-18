# predictive-maintenance

Predictive Maintenance Copilot prototype — a deterministic telemetry-driven
detector service for the Nexus SDV platform. It watches each scheduled VIN's
slow signals (12V battery, brake wear, tire pressure), computes health scores
and alerts with plain math (no ML, no LLM), and publishes `pm.{VIN}.{component}`
messages on NATS that the web dashboard consumes.

Mirrors the `sample-services/trip_analyzer` pattern: a FastAPI app that polls
the data-api per VIN, runs the detectors, and publishes on NATS.

## What it detects

| Component | Method | Alert rules (thresholds) |
|---|---|---|
| **12V battery** | M1: temperature-compensated resting-voltage trend (EWMA + 30-day slope); M2: cranking signature (V_min, internal resistance) | EWMA < 12.4 V or slope < −0.5 mV/day → advisory; EWMA < 12.2 V → action; cranking V_min < 9.5 V or R_int > 1.5× baseline → action/critical |
| **Brake pads** | Per-pad wear fraction (`BRAKE_WEAR.{FL,FR,RL,RR}`) published by the sim; legacy fallback: energy integral `W = Σ m·a·v·Δt` (1500 kg, 6 GJ pad budget) | wear index > 80 % → advisory; > 90 % → action |
| **Tires** | Temperature-compensated pressure trend per wheel (`TIRE_PRESSURE.{FL,FR,RL,RR}` + `TIRE_TEMP.{FL,FR,RL,RR}`; `P_comp = P·T_ref/T`), steady-driving samples | slope < −0.15 bar/month → advisory; P_comp < 1.8 bar → action |

Tires and brakes are modeled **per wheel**: the processor runs `detect_tires`
×4 (one per corner) and `detect_brake` ×4 (one per pad) and publishes
`pm.{VIN}.tires.{wheel}` / `pm.{VIN}.brake.{pad}` subjects so the dashboard
can show which corner is degrading. Evidence dicts carry the `wheel`/`pad`
label. When the per-wheel columns are absent (older simulator, mixed
history) the processor falls back to the legacy single-channel subjects
`pm.{VIN}.tires` / `pm.{VIN}.brake`.

**Continuous health meters** — scores are continuous in the underlying
signal, not step functions that floor once past a threshold: battery maps
resting voltage 12.63 V → 10.5 V onto 100 → 0, tires map compensated
pressure 2.3 bar → 0.9 bar onto 100 → 0. Severity stays driven by the
threshold rules, which can escalate below the meter's reading: battery
EWMA < 12.2 V → action, < 11.8 V → critical; tires P_comp < 1.8 bar →
action, < 1.2 bar → critical.

Detection is **deterministic and explainable** — every alert carries the
evidence (ewma voltage, slope, threshold, wheel/pad…) and a plain-language
explanation built from templates. Details in
`docs/superpowers/research/2026-08-05-predictive-maintenance-*.md` and the
design spec.

## Message contract

`proto/pm-message.proto` defines `PmMessage` (package `pm`) — the message
serialized over NATS by the detector and decoded by the web client. The
betterproto stub is committed at
`src/predictive_maintenance/model/pm_message.py` (generated, DO NOT EDIT).

```proto
message PmMessage {
  string vin = 1;
  string component = 2;   // battery | tires.{wheel} | brake.{pad} (legacy: tires | brake)
  int32 health_score = 3; // 0-100
  string severity = 4;    // healthy | advisory | action | critical
  map<string, string> evidence = 5;
  string explanation = 6;
  string timestamp = 7;   // RFC3339
}
```

Subjects (published on NATS):

| Subject | Payload | Notes |
|---|---|---|
| `pm.{VIN}.battery` | battery health | unchanged |
| `pm.{VIN}.tires.{wheel}` | one per wheel (`FL`/`FR`/`RL`/`RR`) | evidence carries `wheel` |
| `pm.{VIN}.brake.{pad}` | one per pad (`FL`/`FR`/`RL`/`RR`) | evidence carries `pad` |
| `pm.{VIN}.tires` / `pm.{VIN}.brake` | legacy single-channel fallback | only when per-wheel columns absent |

The web SSE route subscribes `pm.>` (full remainder), so the 4-token
subjects arrive with no route change.

Regenerate after changing the proto:

```bash
make proto
```

> `make proto` regenerates into a scratch dir and relocates the flat stub
> (betterproto ≥ 2.0.0b6 emits a package layout that does not match the
> committed file). The relocation path assumes the `pm` package.

## Configuration (env vars)

All settings are environment-driven (pydantic-settings). See `example.env`.

| Variable | Default | Purpose |
|---|---|---|
| `DATA_API_GRPC_ADDR` | `data-api:8080` | data-api gRPC `host:port` |
| `NATS_HOST` / `NATS_PORT` | `nats` / `4222` | NATS server |
| `NATS_USER` / `NATS_PASSWORD` | `connector` / `connector-pass` | NATS account (must have `pm.>` pub perms — see local-dev README) |
| `SCHEDULED_VINS` | (empty) | comma/whitespace-separated VINs to monitor; empty = none |
| `POLL_INTERVAL_SECONDS` | `60` | per-VIN poll cadence |
| `BATTERY_WINDOW_DAYS` | `30` | battery trend lookback (days) |
| `LOG_LEVEL` | `info` | Structured log threshold: `debug`, `info`, `warning`, `error`, or `critical` (case-insensitive) |

## Interfaces

* `GET /` — health: `{status, grpc, nats}`; 200 when data-api is reachable,
  503 otherwise.
* `GET /liveness` — 200 liveness probe.

## Local development

```bash
# from sample-services/predictive-maintenance
make install        # uv sync (first time)
make test           # uv run pytest tests/
make dev            # local uvicorn (needs data-api + NATS reachable)
```

The service runs in the local stack as `predictive-maintenance`
(container `nexus-predictive-maintenance`). One command:

```bash
cd local-dev
make pm-demo        # stack + simulator + detector + open http://localhost:3000/pm
```

The service writes one JSON object per log line to stdout. `LOG_LEVEL` is
validated at startup and filters both PM application logs and framework logs;
the default is `info`. For the local Compose stack, provide the service-level
override before starting the detector:

```bash
cd local-dev
PM_LOG_LEVEL=debug docker compose --env-file .env.base-services \
  --env-file .env.sample-services up -d predictive-maintenance
docker compose logs -f predictive-maintenance
```

Use `debug` to trace telemetry collection and NATS payload sizes. Use `info`
for lifecycle, polling, detector-result, and publish summaries. `warning`,
`error`, and `critical` progressively reduce output to operational problems.
Startup configuration is logged with credentials redacted. The service never
logs raw protobuf payloads or the NATS password.

## Deployment

**Local / demo:** `local-dev/docker-compose.yml` service
`predictive-maintenance` (env injected from `.env.base-services` +
`.env.sample-services`; `SCHEDULED_VINS` defaults to the `VIN_POOL`).

**GCP:** the service is not yet wired into `iac/` (cloudbuild/helm) — the
prototype is local-first. To run it on GCP later, mirror `trip_analyzer`'s
deployment (its `Dockerfile` + cloudbuild/helm patterns): build
`Dockerfile.local`'s equivalent for production, grant the NATS account
`pm.>` perms, point `DATA_API_GRPC_ADDR` at the in-cluster data-api, and set
`SCHEDULED_VINS` from the fleet. See
`docs/superpowers/2026-08-10-predictive-maintenance-guide.md` for the
full operations guide.

## Testing

```bash
make test   # uv run pytest tests/ -v
```

Covers: message round-trip, detector math (healthy/degrading/critical per
component, per-wheel tires, per-pad brakes), processor publish cadence
(publish on severity/band change, healthy publishes nothing, poll errors
never crash, per-wheel subjects + single-channel fallbacks), and the
evaluator's precision/recall math.

## Validation (offline evaluator)

`scripts/evaluate_detectors.py` computes real precision / recall / mean lead
time from a simulator soak + ground-truth labels, and writes
`sample-clients/data-web-client/public/pm-validation.json` (the /pm
validation card). See the guide's "Validation" section for the exact soak.

## Troubleshooting

- **No alerts on /pm** — check the NATS account has `pm.>` pub/sub perms
  (local-dev connector user does; re-run `make go` if `nats.conf` predates the
  `pm.>` grant), the detector is polling (`docker compose logs
  predictive-maintenance` should show `Polling data-api`), and a degrading VIN
  exists (`DEGRADATION_PRESET=critical` for a deterministic first alert).
- **Healthy VINs publish nothing** — by design. Only severity/band changes
  are published.
- **`make proto` leaves stale output** — the relocation assumes one proto
  package (`pm`); a new package needs a matching move line.

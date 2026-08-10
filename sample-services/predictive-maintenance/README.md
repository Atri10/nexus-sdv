# predictive-maintenance

Predictive maintenance prototype service.

## Message contract

`proto/pm-message.proto` defines `PmMessage` (package `pm`) — the message
serialized over NATS by the detector service and decoded by the web client.
The betterproto stub is committed at
`src/predictive_maintenance/model/pm_message.py` (generated, DO NOT EDIT).

Regenerate after changing the proto:

```bash
make proto
```

## Detector service

Mirrors `sample-services/trip_analyzer`'s pattern: FastAPI app
(`predictive_maintenance.main:app`) that polls the data-api per scheduled
VIN, runs the deterministic detectors, and publishes `pm.{vin}.{component}`
alerts on NATS.

- `config/` — pydantic-settings `Settings` (env-driven: `DATA_API_GRPC_ADDR`,
  `NATS_*`, `SCHEDULED_VINS`, `POLL_INTERVAL_SECONDS`, `LOG_LEVEL`),
  structlog setup.
- `client/` — `NatsConnector` (nats-py, JetStream) + `DataApiConnector`
  (grpclib Channel → generated `TelemetryDataApiStub`). The generated data-api
  client is committed at `src/predictive_maintenance/client/generated/dataapi/v1/`
  (DO NOT EDIT; regenerate with `make proto`).
- `core/` — `Processor.run(vin)`: polls `dynamic:battery.*`, `VELOCITY`,
  `acceleration_modulus_m_s2`, `brake_pedal_pct`, `distance_meters`,
  `TIRE_PRESSURE`, `TIRE_TEMP`; temperature-compensates battery resting
  voltages (`V_comp = V - BATTERY_BETA * (T - BATTERY_V_REF)`); accumulates
  brake energy (1500 kg, 6 GJ pad budget); runs
  `detect_battery`/`detect_brake`/`detect_tires`; publishes
  `pm.{vin}.{component}` only when severity != healthy (healthy VINs publish
  nothing). `PmScheduler` (APScheduler AsyncIOScheduler, in-memory) drives the
  per-VIN poll loop.
- `api/` — `/health` (liveness + data-api/nats status), mirroring trip_analyzer.

## Test

```bash
uv run pytest tests/ -v
```

## Local dev

Runs in the local stack via `local-dev/docker-compose.yml` (service
`predictive-maintenance`, container `nexus-predictive-maintenance`).

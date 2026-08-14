# Repository Guidelines

## Project Overview

Nexus SDV is an open-source reference implementation of a connected-vehicle platform for Software-Defined Vehicles (SDV). It ingests vehicle telemetry (from Android Automotive OS VHAL and other sources), transports it to the cloud via NATS, persists it in Google Bigtable, and serves it to web/analytics consumers. The project targets Google Cloud (Terraform + GitHub Actions/Cloud Build) but has a fully self-contained local docker-compose stack. Not an official Google product.

Key documents: `README.md` (pitch/quickstart), `local-dev/ARCHITECTURE.md` (authoritative local architecture), `local-dev/README.md` (local stack guide), `docs/` (Astro/Starlight source for docs.nexus-sdv.io).

## Architecture & Data Flow

```
Vehicle/devices (Go/Python/ESP32 clients) + vehicle-simulator (local demo)
  │  mTLS: factory cert → registration → operational cert → Keycloak JWT
  ▼
NATS (telemetry.{VIN}, telemetry-generic.{VIN}.{sensor}, pm.{VIN}.{component})
  │  auth-callout validates Keycloak JWT ($SYS.REQ.USER.AUTH) → per-VIN NATS perms
  ▼
nats-bigtable-connector (Go locally, wombat/Benthos on GCP)
  ▼
Bigtable table `telemetry` — row key {device_id}#{RFC3339Nano}, families static/dynamic
  ▼
data-api (gRPC, server-streaming) → consumers: data-api-sampler (REST),
  trip_analyzer (FastAPI scoring, republishes scoring.{VIN}),
  predictive-maintenance (FastAPI detectors, publishes pm.{VIN}.{component}),
  telemetry-chart-service (REST + WebSocket), data-web-client (Next.js, SSE: demo + PM)
```
- **Ingress paths**: (1) clients publish protobuf directly to NATS — `telemetry.{VIN}` carries `MetricsReport` wrapping `com.android.sdv.telemetry.VehicleTelemetryData`, `telemetry-generic.{VIN}.{sensor}` carries `telemetry.TelemetryMessage`; (2) MQTT path: Mosquitto `:1883` topic `telemetry/+/sensors/#` → `data-converter` (parses to `TelemetryMessage`, republishes to `telemetry-generic.*`); (3) local demo: `vehicle-simulator` (the Go vehicle-client in NATS control mode) publishes both message types and is controlled over `commands.{VIN}.demo`.
- **Auth**: 4-stage lifecycle — Registration (factory cert → operational cert via CSR signing over mTLS) → Keycloak JWT (RS256) → NATS connect token → auth-callout maps roles (`edge-device`, `telemetry-client`, `telemetry-collector`) to per-VIN NATS permissions. PKI is dual-mode: `local` (self-signed openssl CAs) vs `remote` (GCP Certificate Authority Service).
- **Predictive maintenance**: `sample-services/predictive-maintenance` polls data-api for each VIN, runs deterministic battery/brake/tire detectors, and publishes severity to `pm.{VIN}.{component}`. The web client streams these via SSE (`/api/pm/stream`) into the `/demo` health gauges and the `/pm` single-vehicle live console. The simulator can degrade components over time (`DEGRADATION_PRESET`, `DEGRADATION_ACCEL`) and drives demo pacing (`DEMO_SPEED` 1x/5x/20x).
- **Telemetry formats** (see `proto/*.proto`): C++ `TelemetryMessage`, Go/Java `VehicleTelemetryData` on `telemetry.{VIN}`, AAOS `VehicleTelemetryData` (schema exists, not actively published), legacy raw JSON on `telemetry-generic.{VIN}.battery`. Do not claim AAOS is actively used.

## Key Directories

| Path | Purpose |
|---|---|
| `proto/` | Shared protobuf schema root (7 files: telemetry, vehicle_telemetry, aaos_vehicle_telemetry, carla_simulation_report, data-api, display_safety, metrics_report). Services keep local copies; regenerate stubs at build time. |
| `base-services/` | Production platform services. Go 1.24/1.25: `nats-bigtable-connector/`, `data-converter/` (MQTT→NATS), `data-api/` (gRPC), `auth-callout/` (NATS auth callout). Rust: `registration/server/` (axum, mTLS cert issuance). |
| `sample-services/` | Reference consumers: `trip_analyzer/` (Python FastAPI), `predictive-maintenance/` (Python FastAPI PM detector service), `telemetry-chart-service/` (Java Spring Boot), `data-api-sampler/` (Java Spring Boot + gRPC). |
| `sample-clients/` | Client SDKs & demos: `vehicle-client/` (Go — also the local `vehicle-simulator` demo source with degradation + trip-route logic), `telemetry-subscriber/` (Go), `python/` (SDK + simulators, uv), `devices/` (Python lifecycle client), `iot-client/` (ESP32 C++ PlatformIO), `data-web-client/` (Next.js dashboard: fleet, device, `/demo`, `/pm`), cert-generation shell scripts. |
| `local-dev/` | Local stack: `docker-compose{,.infra,.certs}.yml`, `Makefile`, `setup-automated.sh`, `scripts/`, `configs/*.template` (env templates), `config/` (service YAMLs), `keycloak/nexus-realm.json`, `ARCHITECTURE.md`. |
| `iac/` | GCP deployment: `terraform/`, `helm/` (10 charts) + `helmfile.d/`, `cloudbuild/`, `bootstrapping/` (bootstrap/teardown scripts), `scripts/`. |
| `docs/` | Documentation site source; design/spec docs in `docs/superpowers/specs/` and `docs/superpowers/plans/`. |
| `.github/workflows/` | 19 workflows: bootstrap orchestrator, tests, trivy scans, per-service build/push/deploy. |

## Development Commands

Local stack (all of local-dev, no GCP needed):

```bash
cd local-dev
make go            # full bring-up: certs → NKey/JWKS → infra → build --no-cache → verify (~2–3 min first run)
make demo          # one-command stack + vehicle-simulator + dashboard (simulator restart: on-failure)
make pm-demo       # stack + simulator + predictive-maintenance (live PM board on /pm)
make test          # smoke test: services up, endpoints reachable, MQTT→NATS→Bigtable ingress check
make ingest        # seed one sample row (VIN123) into Bigtable emulator
make query         # cbt read; usage: ./scripts/query-bigtable.sh "VIN123#2026-07-13T17:00:00.000000000Z"
make vehicle-client # run the Go client against the local stack (requires protoc + go on PATH)
make logs / stop / clean / status / shell / frontend / connector-logs / setup-auto
make clean && make go   # full PKI + state regeneration
```

Per-service (each has its own Makefile):

- Go: `go build ./...`, `go test ./...` (`base-services/data-api/Makefile`: `make deps`, `make proto`, `make test`)
- Rust: `cargo build` / `cargo test` (`base-services/registration/server/`)
- Java: `./mvnw clean package` (`sample-services/{data-api-sampler,telemetry-chart-service}/`)
- Python: `uv sync && uv run pytest tests/` (`sample-services/{trip_analyzer,predictive-maintenance}/`); `make all` for clients (`sample-clients/python/`, `sample-clients/devices/`)
- Web: `cd sample-clients/data-web-client && bun install && bun run dev` (Next.js); `bun run lint` (eslint), `bun run build`, `bun test --isolate`
- Proto regeneration: `make proto` per service (protoc for Go/Rust, grpc_tools/betterproto for Python, protobuf-maven-plugin for Java); protoc must be on PATH.

GCP deployment: `bash iac/bootstrapping/bootstrap-platform.sh` (interactive; also `iac/cloudbuild/deploy-all.yaml`); teardown: `bash iac/bootstrapping/teardown-platform.sh`.

## Code Conventions & Common Patterns

- **Configuration is environment-driven.** Services read env vars only; the canonical names live in `local-dev/configs/*.template` (`JWT_ACC_SIGNING_KEY`, `KEYCLOAK_JWK_B64`, `NATS_URL`, `GRPC_ADDR`, `BT_TABLE`, `GCP_PROJECT`, `LOG_LEVEL`, …). Every service supports `LOG_LEVEL`. Local compose injects `.env.infra` / `.env.base-services` / `.env.sample-services` generated from templates by `setup-automated.sh`.
- **NATS subject naming**: `telemetry.{VIN}`, `telemetry-generic.{VIN}.{sensor}`, `commands.{VIN}.>`, `scoring.{VIN}`. VIN is always the first subject token.
- **Protobuf workflow**: edit the canonical `.proto` in `proto/`, copy it into the service's local `proto/` dir, regenerate stubs, commit both. Do not hand-edit generated stubs (they are gitignored where applicable, e.g. `*.pb.go`).
- **Go services** (base-services): entry `src/main.go`, domain logic in `src/service/` (e.g. `data-api/src/service/{server,bigtable,time}.go`), zap logging, table-driven unit tests, gRPC via protoc-generated stubs.
- **Rust (registration)**: axum handlers with TLS listener; certificates hot-reload via `notify` + `arc-swap` (`cert_reloader.rs`); mTLS client cert CN must match CSR CN `VIN:xxx DEVICE:yyy`.
- **Java (Spring Boot 3.5.16)**: layout `config/` (BigtableConfig, SecurityConfig), `web/` (controllers/WebSocket), `service/`; endpoints under `/api/v1/...`; WebSocket live telemetry polls Bigtable every 1s.
- **Python (trip_analyzer / predictive-maintenance)**: FastAPI apps (`trip_analyzer.main:app`, `predictive_maintenance.main:app`), config via pydantic-settings (`Settings` with env overrides), modules split `client/`, `core/`, `api/`; betterproto-generated stubs; structlog logging in predictive-maintenance.
- **Client cert scripts** share one convention: PKI strategy `local|remote`, `include ../../iac/bootstrapping/.bootstrap_env` in Makefiles, cert CN format `VIN:<VIN> DEVICE:<DEVICE>`. Generated PKI artifacts (`*.pem`, `*.key`, `*.crt`) are gitignored.
- **Security**: all vehicle↔cloud traffic is mTLS-authenticated; never hardcode or commit certs/keys/secrets (`.gitignore` blocks them).

## Git Workflow

- **Branches**: `dev` is the integration branch — all work lands there as feature branches merged with `--no-ff` (`feature/F<N>-<name>`), each feature branch containing its own small commits. `main` mirrors upstream (release-only).
- **Commits**: Conventional Commits (`feat(pm): ...`, `fix(web): ...`, `docs: ...`, `chore: ...`); imperative summaries; one logical change per commit. All commits signed with the owner's ssh key.
- **History**: never rewrite pushed history casually; keep the feature-merge structure (`git log --graph`).

## Important Files

- `README.md`, `local-dev/ARCHITECTURE.md`, `local-dev/README.md` — project pitch, architecture, local ops
- `proto/*.proto` — canonical schemas; `proto/data-api.proto` defines the gRPC `dataapi.v1.TelemetryDataAPI` contract
- `local-dev/configs/*.template` — the authoritative env-var catalog; `local-dev/config/data-converter.yaml` — data-converter mapping (MQTT topic → NATS subject templates)
- Entry points: `base-services/data-api/src/main.go`, `base-services/data-converter/src/main.go`, `base-services/nats-bigtable-connector/src/main.go`, `base-services/auth-callout/main.go`, `base-services/registration/server/src/main.rs`, `sample-services/trip_analyzer/src/trip_analyzer/main.py`, `sample-services/predictive-maintenance/src/predictive_maintenance/main.py`, `sample-services/telemetry-chart-service/src/main/java/.../TelemetryChartServiceApplication.java`, `sample-services/data-api-sampler/src/main/java/.../DataApiSamplerApplication.java`, `sample-clients/data-web-client/src/app/` (Next.js app router)
- `sample-clients/vehicle-client/main.go` — canonical end-to-end client (cert flow + NATS publish); also hosts the demo simulator logic (`trip_logic.go`, `trip_route.go`, `degradation.go`)
- `iac/terraform/*.tf` — GCP resources (GKE Autopilot, Bigtable `bigtable-production-storage`, Cloud SQL Postgres 15); `iac/helm/helmfile.d/*.gotmpl` — production deployments
- `.github/workflows/test-base-services.yml` + `test-web-client.yml` — the CI test workflows

## Runtime/Tooling Preferences

- **Versions**: Go 1.24 (data-api uses 1.25), Rust stable (musl cross-build → scratch image), JDK 21 (Spring Boot 3.5.16), Python ≥3.13 with **uv** as package manager, Node 22 with **bun** for `data-web-client` (`bun.lock` committed), Next.js 16 (NextAuth 4 incompatible — demo/PM use `DEMO_MODE=true`), NATS 2.10, Keycloak 25.0 (host port 8088), Mosquitto 2, Terraform ≥1.11.4, helm v3.19.0.
- **Package managers**: Go modules, `mvnw` wrapper (no system Maven), `uv` (Python), `bun` (web client — do not use npm).
- **Local tooling required for full flows**: Docker (compose v2), `protoc` + Go plugins (`protoc-gen-go`, `protoc-gen-go-grpc`), `gcloud` CLI + `cbt` component, `openssl`, `nk` (NATS NKeys), `jq`.
- **Generated artifacts never committed**: `*.pb.go`, PKI files, `local-dev/certs/`, `local-dev/.env.*`, `local-dev/config/nats.conf`, terraform state. `make clean` regenerates them.
- **No formatter/linter configs** are enforced by CI (no gofmt/gofmt gate, no ruff/eslint CI step, no checkstyle). Keep to per-language defaults (gofmt, ruff/black defaults, prettier where the web client uses it).

## Testing & QA

- **Go**: std `testing`; `testify` used in auth-callout and data-api. `data-converter`: `go test -v -count=1 ./tests/unit/...` (`make test`). `data-api`: godog/Cucumber integration suite in `tests/integration/` (in-process `bttest` Bigtable emulator + in-process gRPC) — `make test` runs integration only; `src/service/` unit tests are NOT run by `make test` or CI. nats-bigtable-connector has `src/main_test.go`; vehicle-client has unit tests (`*_test.go`); telemetry-subscriber has **zero tests**.
- **Rust**: inline `#[cfg(test)]` modules + `#[tokio::test]`; `cargo test` (runs in CI).
- **Python**: pytest with `asyncio_mode=auto`. `trip_analyzer`: `tests/conftest.py` provides a `client` fixture patching NatsConnector/DataApiConnector with AsyncMock; `uv run pytest tests/`; no CI test step. `predictive-maintenance`: 8 test files under `tests/` (`uv run pytest tests/`).
- **Java (data-api-sampler)**: JUnit5 + Spring Boot Test + Mockito + AssertJ + WebTestClient; naming convention `*Test` = unit, `*ITCase` = integration (`mvn test`). telemetry-chart-service has one service unit test (`TelemetryServiceRowKeyTest`).
- **TypeScript (data-web-client)**: bun test (`bun test --isolate`, ~32 test files, React Testing Library); `bun run lint` (eslint) and `bun run build` also part of local verification. CI job `test-web-client.yml` runs `bun run test` + `bun run lint` on ubuntu-latest. Jest infra was removed (migrated to bun test).
- **IaC**: `terraform test -verbose` (`iac/terraform/tests/main.tftest.hcl`), bash structure/syntax checks, one helm test hook.
- **CI**: `test-base-services.yml` (data-api, auth-callout, registration) + `test-web-client.yml` (bun test/lint). Everything else is build/push/deploy or trivy scans. **No coverage tooling exists anywhere** (no jacoco, pytest-cov, or coverage scripts) — do not add coverage expectations.
- **Local smoke test**: `make test` in `local-dev/` (script `local-dev/scripts/test-local-flow.sh`) validates the full ingest path; `make pm-demo` exercises the PM pipeline (simulator degradation → detectors → pm.* alerts → /pm board).

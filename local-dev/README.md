# Nexus SDV — Local Development Environment

A complete, self-contained local stack: all infrastructure and application
services run in Docker, and one command generates every cert, key, and token
and starts everything. **No GCP account, no Secret Manager, no manual token
copying.**

> New here? Read **[Quick Start](#1-quick-start)** → **[How the pieces fit
> together](#2-how-the-pieces-fit-together)** → **[Working with data](#5-working-with-data)**.
> That is enough to be productive. Everything after is reference.

---

## 1. Quick Start

```bash
cd local-dev
make go
```

`make go` runs `setup-automated.sh` (first time only) then starts every
service: generates TLS certs, the NATS NKey pair, and the Keycloak JWKS
snapshot and injects them automatically. First run takes ~2–3 minutes
(it builds images with `--no-cache`).

Then confirm it's up:

```bash
make status      # health of every container
make logs        # tail all logs (Ctrl+C to stop)
```

**Vehicle client:** use the local-dev wrapper `make vehicle-client` (or
`bash scripts/run-vehicle-client.sh`) — do NOT run
`sample-clients/vehicle-client/run-vehicle-client.sh` directly (it targets
GCP settings and the wrong TLS config).

**Demo mode:** `make demo` is the one-command path to the interactive demo —
it idempotently ensures the stack + vehicle simulator are up, then opens
**http://localhost:3000/demo** (see [Demo mode](#8-demo-mode)).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for how the system is wired.

---

## 2. How the pieces fit together

Everything shares the `nexus-local` Docker bridge network.

| File | Brings up | Purpose |
|------|-----------|---------|
| `docker-compose.infra.yml` | NATS, Keycloak, Bigtable emulator, Mosquitto | Infrastructure |
| `docker-compose.yml` | Data API, Auth Callout, Data Converter, Registration, chart service, web frontend, sample services | Application services |
| `docker-compose.certs.yml` | cert-generator (one-shot) | Generates the PKI |

### Data flow

```
Vehicle client ──mTLS──► Registration (:8444) ──► operational cert
MQTT :1883 ──► data-converter ──► NATS telemetry-generic.>   ┐
vehicle-client ──► NATS telemetry.{VIN} (MetricsReport)      ├─► nats-bigtable-connector
Keycloak JWT ──► NATS auth-callout grants per-VIN perms      ┘   (Go service) ──► Bigtable
                                                                                     │
Data API :9090 (gRPC) ◄── Bigtable rows ◄────────────────────────────────────────────┘
chart service :8081 (REST + WS) ◄── Bigtable ──► web frontend :3000
```

Both ingress paths (MQTT and direct NATS publish) land in Bigtable via the
connector — see [Working with data](#5-working-with-data).

### Authentication chain

```
factory cert ──mTLS──► Registration ──► operational cert
operational cert ──► Keycloak (client-secret, per-VIN client) ──► JWT
JWT ──► NATS ──► Auth Callout verifies JWT against Keycloak's JWKS snapshot ──► NATS permissions
```

Auth Callout trusts a **snapshot** of Keycloak's public keys taken at setup —
see [Known gaps & gotchas](#11-known-gaps--gotchas) for why that matters.

---

## 3. Command reference (`make`)

Run all of these from inside `local-dev/`.

| Command | What it does |
|---------|--------------|
| `make go` | First-time setup **+** start everything (the one you want) |
| `make setup-auto` | Run only the automated setup (certs/keys/tokens/env), don't start services |
| `make status` | Show health of all containers |
| `make logs` | Tail all logs in real time |
| `make ingest` | Write one sample telemetry row into Bigtable |
| `make query` | Query Bigtable for telemetry rows |
| `make test` | Run the end-to-end test flow (incl. the full vehicle flow) |
| `make vehicle-client` | Register + publish telemetry using the real vehicle-client simulator |
| `make shell` | Open a shell in the `data-api` container |
| `make connector-logs` | Tail nats-bigtable-connector logs |
| `make frontend` | Tail data-web-client logs |
| `make stop` | Stop containers (keeps volumes) |
| `make clean` | Stop containers, remove volumes, `.env` files **and** generated certs (`certs/`) |
| `make help` | Print the full command list |

---

## 4. Service URLs & credentials

| Service | Endpoint | Notes |
|---------|----------|-------|
| **NATS** | `nats://localhost:4222` | NKey + auth-callout; HTTP monitor `http://localhost:8222` |
| **Keycloak** | `http://localhost:8080` (admin UI) | admin/admin · realm `nexus-sdv` |
| **Bigtable emulator** | `localhost:8086` | project `test-project`, instance `test-instance`, table `telemetry` |
| **Mosquitto (MQTT)** | `mqtt://localhost:1883` | topic base `telemetry/#` |
| **Data API (gRPC)** | `localhost:9090` | plaintext; container listens on 8080 |
| **Registration** | `https://localhost:8444` | mTLS |
| **Telemetry Chart Service** | `http://localhost:8081` | Java REST + WebSocket API |
| **Frontend (Next.js)** | `http://localhost:3000` | Live charts UI (no auth required) |

### NATS built-in accounts (from generated `config/nats.conf`)

Created by `setup-automated.sh` for host-side tooling. They **bypass** the JWT
auth callout, so no Keycloak token is needed.

| User | Password | Permissions | Use for |
|------|----------|-------------|---------|
| `connector` | `connector-pass` | pub/sub on `telemetry.>`, `telemetry-generic.>`, `local.telemetry.>`, `scoring.>`, `commands.>` | Subscribing/publishing telemetry from the host or nats-box |
| `app-user` | `app-pass` | (account `APP`) | Application-account connections |
| `auth-callout-service` | `auth-callout-pass` | (account `AUTH`) | The auth-callout service itself |

> These credentials are **local-dev only** and intentionally not secret — they
> live in the generated `config/nats.conf`. Never reuse them anywhere real.

---

## 5. Working with data

### The one thing to know first

> **Local dev has a NATS → Bigtable writer.** The `nats-bigtable-connector`
> (Go service) subscribes to `telemetry.>` and `telemetry-generic.>` and
> writes decoded protobuf messages into the Bigtable emulator. The loop
> closes: MQTT → data-converter → NATS → connector → Bigtable → Data API.
>
> The Bigtable emulator is **in-memory**: a container restart wipes the table.
> `make ingest`/`make query` recreate the table + column families automatically.

### Data model

Source of truth: `base-services/data-api/src/service/bigtable.go` and `time.go`.

- **Row key:** `<VIN>#<timestamp>`, timestamp format
  `2006-01-02T15:04:05.000000000Z07:00` — e.g. `VIN123#2026-07-13T17:00:00.000000000Z`.
  data-api scans a `<VIN>#<start>` .. `<VIN>#<end>` key range, so the `#` and
  the exact timestamp format matter.
- **Columns:** `<family>:<qualifier>`; family is `dynamic` or `static` —
  e.g. `dynamic:speed`, `static:make`. Values are stored as raw bytes.

### Write telemetry (ingest)

```bash
make ingest                                   # one sample row (VIN123, timestamp = now)
bash scripts/ingest-sample.sh MYVIN 2026-07-13T17:00:00.000000000Z   # custom VIN / time
```

For live data instead of manual seeding, run `make vehicle-client` (section 6)
or publish over MQTT (below) — both land in Bigtable via the connector.

### Read telemetry (query)

```bash
make query                                              # all rows (raw, via cbt)
bash scripts/query-bigtable.sh "VIN123#2026-07-13T17:00:00.000000000Z"  # one row by full key
```

### Inspect live NATS messages

NATS has **no anonymous access** — a credential-less connection is rejected
with `nats: Authorization Violation`. Use the built-in `connector` account.

The easiest way, with nothing installed locally, is the `nats-box` image on the
`nexus-local` network:

```bash
docker run --rm --network nexus-local natsio/nats-box:latest \
  nats sub "telemetry.>" \
  --user connector --password connector-pass \
  --server nats://nats:4222
```

> Inside the network the host is `nats`, not `localhost`.

**Subjects to watch.** The vehicle client publishes per `--message-type`:

| Message type | Subject |
|--------------|---------|
| `telemetry` | `telemetry-generic.<VIN>.battery` (TelemetryMessage) |
| `metrics_report` (default) | `telemetry.<VIN>` (MetricsReport) |

**HTTP monitoring** (no auth, no tools needed):

```bash
curl http://localhost:8222/connz   # connections
curl http://localhost:8222/subsz   # subscriptions
curl http://localhost:8222/varz    # server stats
```

### Publish over MQTT

Exercises the `MQTT → data-converter → NATS → connector → Bigtable` path.
Requires `mosquitto_pub` on your host.

```bash
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
  -m '{"name":"temp","value":25.5,"unit":"C"}'
```

To see it arrive, subscribe on NATS (above) in another terminal first.

### Read via the Data API (gRPC)

`data-api` serves telemetry over gRPC at `localhost:9090` (plaintext). The
client imports generated protobuf stubs that are produced during the Docker
build and are not committed — generate them first (protoc + protoc-gen-go /
protoc-gen-go-grpc, the same step `base-services/data-api/Dockerfile.local`
performs):

```bash
go -C base-services/data-api run ./client -addr localhost:9090 -vin VIN123
```

The sample client requests `static:index`, `static:test_key`,
`dynamic:time_passed`, so ingest a row carrying those columns to see it return
data. `make query` (cbt) is the simplest read path and needs no toolchain.

### End-to-end test

```bash
make test
# or: bash scripts/test-local-flow.sh
```

Covers: services up, endpoints reachable, MQTT → NATS → Bigtable ingress, and
the full vehicle flow (registration → JWT → NATS publish → Bigtable rows).

---

## 6. Running the vehicle client

[`sample-clients/vehicle-client`](../sample-clients/vehicle-client) is a real
vehicle simulator: registers with the registration server via mTLS,
authenticates with Keycloak, and publishes telemetry to NATS. Its own
`run-vehicle-client.sh` expects a GCP bootstrap env file, so use the local-dev
wrapper, which supplies everything from the running stack:

```bash
make vehicle-client
# or with options (passed through to the underlying script):
bash scripts/run-vehicle-client.sh --vin VIN123 --interval 5 --message-type telemetry
```

The wrapper generates a factory cert signed by local-dev's factory CA (the one
`registration` trusts), stages the TLS cert files the client reads, forces
`PKI_STRATEGY=local`, and points the client at local-dev's host ports. It
authenticates to Keycloak with the **per-VIN client** `VIN123` (secret read from
the realm import via `jq`), which makes `azp = VIN123` — exactly what the
auth-callout grants NATS permissions on (`telemetry.VIN123.>`).

**Requires:** the stack running (`make go`), plus `protoc` and `go` on `PATH`.

**What works end to end:** factory cert → mTLS registration → operational cert
→ Keycloak JWT → NATS publish → connector → Bigtable rows. `make test` (Test 5)
verifies this loop automatically.

---

## 7. Frontend dashboard

The [Next.js frontend](../sample-clients/data-web-client) runs at
**http://localhost:3000** (fleet list) and **/device/<VIN>** (live charts,
data table, GPS map). Start the stack, run the vehicle client, open the page:

```bash
make go
bash scripts/run-vehicle-client.sh --vin VIN123 --interval 5
open http://localhost:3000/device/VIN123
```

- Live charts (Chart.js) update ~1s via WebSocket to the chart service;
  historical data loads from the same service (time ranges 1h/6h/24h/7d).
- Series toggles, line/area/bar types, dual axis, zoom/pan, VIN comparison,
  and a KPI strip of latest values are on the device page.
- The `/demo` page auto-discovers the running simulator (it probes the VIN
  pool over NATS), so Start/Stop work on first press without matching VINs
  by hand.
- No authentication is required for the device pages.
- The frontend talks to the chart service at `:8081` — REST via the
  `/api/telemetry/[vin]` proxy route, live updates via WebSocket
  `/api/v1/vehicles/{vin}/telemetry/live`.

---

## 8. Demo mode

One command runs the whole demo — stack, vehicle simulator, and dashboard:

```bash
cd local-dev
make demo
```

`make demo` is idempotent: it runs the same setup/start as `make go` (a no-op
when already configured), ensures the `vehicle-simulator` container is up, then
opens **http://localhost:3000/demo**. No authentication is required on the
demo pages.

The `/demo` page is the interactive dashboard:

- **Vehicle schematic** — an SVG car with clickable component nodes (battery,
  powertrain, chassis, cabin); each node shows the live value of its sensors.
- **Animated data path** — Component → NATS → Connector → Bigtable → Chart
  service → Graph, with the active stage pulsing while telemetry flows.
- **Live chart** — telemetry for the selected component's sensors, fed over
  WebSocket by the chart service (same backend as `/device/<VIN>`).
- **Start / Stop buttons** — control the simulator per VIN: the page POSTs to
  the web control route (`/api/demo/vehicle`), which sends a NATS
  request/reply on `commands.<VIN>.demo`; the simulator publishes
  TelemetryMessage on `telemetry-generic.<VIN>.battery` and MetricsReport on
  `telemetry.<VIN>` while running, and the connector persists everything into
  Bigtable.

The simulator starts **idle** on stack startup (random VIN from the pool
`VIN1001`–`VIN1010`) — telemetry only flows once you press Start, or use the
manual wrapper `make vehicle-client` for the host-side flow. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the control flow.

> **Pre-branch installs:** if your stack predates this branch (existing
> `keycloak-data` volume / `.env.infra`), run `make clean && make go` once so
> the realm VIN pool and the connector `commands.>` permission are applied.

---

## 9. Build model (Dockerfile.local & proto)

Every local-dev service builds from a **`Dockerfile.local`** next to its
regular `Dockerfile` (see the `dockerfile:` key per service in
`docker-compose.yml`). The GCP-deployed image is still built from the original
`Dockerfile`, untouched by local-dev.

`data-api` and `data-converter` build with the **repo root** as their Docker
build context, so their Dockerfiles generate Go protobuf/gRPC stubs from the
shared `../proto/*.proto` files at build time — no generated code is committed.

> **Do not edit a service's `Dockerfile` to fix a local-dev-only problem** —
> put the fix in `Dockerfile.local` instead.

---

## 10. Environment files

Three `.env` files are generated by `setup-automated.sh` and **never edited by
hand** (they're gitignored and contain secrets):

| File | Contents |
|------|----------|
| `.env.infra` | Infrastructure credentials (NATS NKey, Keycloak admin, …) |
| `.env.base-services` | Base-services config (signing keys, service URLs, `KEYCLOAK_JWK_B64`) |
| `.env.sample-services` | Sample-services config |

The source-of-truth defaults live in `configs/*.template`; setup copies them and
injects the dynamic tokens.

---

## 11. Known gaps & gotchas

| Gap / gotcha | Impact | What to do |
|--------------|--------|------------|
| **Bigtable emulator is in-memory** | Table wiped on container restart | Re-run `make ingest` (it recreates table + families) |
| **Anonymous NATS is denied** | `nats sub`/`pub` with no creds → `Authorization Violation` | Use `--user connector --password connector-pass` |
| **Keycloak key rotation** | See below — vehicle-client fails at the NATS step after a restart | `make clean && make go` (the `keycloak-data` volume keeps keys stable) |
| **Keycloak X.509 client-auth unsupported** | Vehicle authenticates with a client secret, not a client cert | Intended for local dev; the per-VIN client flow works end to end |
| **Running vehicle client directly fails with TLS error** | `remote error: tls: error decrypting message` | Must use local-dev wrapper: `make vehicle-client` or `bash scripts/run-vehicle-client.sh` |

### Keycloak key rotation (the "worked yesterday, broken today" one)

Auth Callout validates Keycloak JWTs against a **one-time JWKS snapshot** taken
at setup (`KEYCLOAK_JWK_B64`, parsed once at auth-callout startup — it never
refetches). If Keycloak regenerates its realm signing key, every fresh JWT has
a new `kid` the snapshot doesn't know, and NATS returns `Authorization
Violation` — even though registration and JWT issuance both succeeded.

`docker-compose.infra.yml` gives Keycloak a **persistent `keycloak-data`
volume** so its signing keys survive restarts and the snapshot stays valid.
Quick unblock without a full rebuild — re-snapshot the JWKS and restart just
auth-callout:

```bash
make setup-auto
docker compose --env-file .env.base-services --env-file .env.sample-services \
  up -d --force-recreate auth-callout
```

---

## 12. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `network nexus-local not found` | It's created by `docker-compose.infra.yml`; run `make go`. Don't `docker network create` it by hand — a manually-made network lacks the compose labels the app services expect. |
| Port already in use | Stop the conflicting service or change the port mapping in the compose file |
| `nats: Authorization Violation` (tooling) | Add `--user connector --password connector-pass` |
| `nats: Authorization Violation` (vehicle-client) | Keycloak key rotation — see [gaps](#keycloak-key-rotation-the-worked-yesterday-broken-today-one) |
| `table ... not found` on `make query` | `phase_bigtable_schema` didn't run — `make setup-auto`, or just `make ingest` (recreates it) |
| `make query` returns nothing | Fresh env has no rows — run `make ingest` (sample row) or `make vehicle-client` (live flow) |
| Keycloak cert errors | `make clean && make go` |
| Build failures | `docker builder prune`, then `make clean && make go` |
| A container crashed on startup | `make status`, then `docker compose logs <service>` |

Useful health checks:

```bash
curl http://localhost:8222/healthz          # NATS
curl http://localhost:8080/health/ready      # Keycloak
docker compose ps                            # container status
```

**Full reset:** `make clean && make go`.

---

## 13. File structure

```
local-dev/
├── Makefile                  # All commands ('make help')
├── README.md                 # This file
├── ARCHITECTURE.md           # System design, data flow, diagrams
├── go.sh                     # Entry point for 'make go'
├── setup-automated.sh        # 10-phase automated setup pipeline
├── docker-compose.yml        # App services
├── docker-compose.infra.yml  # Infrastructure (+ keycloak-data, mosquitto-data volumes)
├── docker-compose.certs.yml  # Cert generation
├── certs/                    # Generated certificates (gitignored)
│   ├── ca/  registration/  nats/  keycloak/
├── config/                   # Runtime configs
│   ├── nats.conf             # Generated by setup-automated.sh
│   ├── mosquitto.conf
│   └── data-converter.yaml
├── configs/                  # Env-file templates (source of truth for defaults)
│   ├── infra.template
│   ├── base-services.template
│   └── sample-services.template
├── keycloak/
│   └── nexus-realm.json      # Realm import
└── scripts/
    ├── generate-certs.sh      # Runs in the cert-generator container
    ├── ingest-sample.sh       # Write a sample telemetry row into Bigtable
    ├── query-bigtable.sh      # Bigtable query tool
    ├── run-vehicle-client.sh  # Wrapper for sample-clients/vehicle-client
    ├── test-local-flow.sh     # End-to-end test
    └── wait-for-services.sh   # Health-check polling
```

---

**Related docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) ·
[vehicle-client README](../sample-clients/vehicle-client/README.md)

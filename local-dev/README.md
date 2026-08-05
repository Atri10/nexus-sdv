# Nexus SDV — Local Development Environment

A complete, self-contained local stack: all infrastructure and application
services run in Docker, and one command generates every cert, key, and token
and starts everything. **No GCP account, no Secret Manager, no manual token
copying.**

> New here? Read **[Quick Start](#1-quick-start)** → **[How the pieces fit
> together](#2-how-the-pieces-fit-together)** → **[Working with data](#5-working-with-data)**.
> That is enough to be productive. Everything after is reference.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [How the pieces fit together](#2-how-the-pieces-fit-together)
3. [Command reference (`make`)](#3-command-reference-make)
4. [Service URLs & credentials](#4-service-urls--credentials)
5. [Working with data](#5-working-with-data)
   - [The one thing to know first](#the-one-thing-to-know-first)
   - [Write telemetry (ingest)](#write-telemetry-ingest)
   - [Read telemetry (query)](#read-telemetry-query)
   - [Inspect live NATS messages](#inspect-live-nats-messages)
   - [Publish over MQTT](#publish-over-mqtt)
   - [Read via the Data API (gRPC)](#read-via-the-data-api-grpc)
6. [Running the vehicle client](#6-running-the-vehicle-client)
7. [Build model (Dockerfile.local & proto)](#7-build-model-dockerfilelocal--proto)
8. [Environment files](#8-environment-files)
9. [Known gaps & gotchas](#9-known-gaps--gotchas)
10. [Troubleshooting](#10-troubleshooting)
11. [File structure](#11-file-structure)

---

## 1. Quick Start

```bash
cd local-dev
make go
```

> **For the vehicle client:** Use the local-dev wrapper `make vehicle-client` or `bash scripts/run-vehicle-client.sh` — do NOT run `sample-clients/vehicle-client/run-vehicle-client.sh` directly (it uses GCP settings and wrong TLS config).

`make go` runs `setup-automated.sh` (first time only) then starts every
service. It generates TLS certs, the NATS NKey pair, and the Keycloak JWKS
snapshot and injects them automatically. First run takes ~2–3 minutes
(it builds images with `--no-cache`).

Then confirm it's up:

```bash
make status      # health of every container
make logs        # tail all logs (Ctrl+C to stop)
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for deeper diagrams and each setup
phase.

---

## 2. How the pieces fit together

### Two compose files, one network

Everything shares the `nexus-local` Docker bridge network.

| File | Brings up | Purpose |
|------|-----------|---------|
| `docker-compose.infra.yml` | NATS, Keycloak, Bigtable emulator, Mosquitto | Infrastructure |
| `docker-compose.yml` | Data API, Auth Callout, Data Converter, Registration, Data API Sampler, Trip Analyzer | Application services |
| `docker-compose.certs.yml` | cert-generator (one-shot) | Generates the PKI |

### Data flow (what actually happens)

```
                MQTT                    NATS                     Bigtable
 Vehicle  ───────────────► Mosquitto ──────────► Data Converter ──────► NATS (telemetry-generic.>)
 client                    :1883                  (MQTT → NATS)                  │
    │                                                                           │  nats-bigtable-connector
    │ mTLS register                                                             │  (wombat) consumes
    ▼                                                                           ▼  into Bigtable
 Registration :8444 ──► issues operational cert + Keycloak/NATS URLs        (stored)

 Keycloak :8080  ──► issues JWT ──► NATS Auth Callout validates JWT ──► grants NATS permissions

 Data API :9090 (gRPC) ◄─────────────────────────────────────────────────────────┘  (reads)
```

Read this diagram together with **[the one thing to know
first](#the-one-thing-to-know-first)** — the NATS→Bigtable gap is now closed
locally by the connector service.

### Authentication chain (vehicle client)

```
factory cert ──mTLS──► Registration ──► operational cert
operational cert ──mTLS──► Keycloak ──► JWT
JWT ──► NATS ──► Auth Callout verifies JWT signature against Keycloak's JWKS ──► publish allowed
```

Auth Callout is the service that turns a Keycloak JWT into NATS permissions. It
trusts a **snapshot** of Keycloak's public keys taken at setup — see
[Known gaps & gotchas](#9-known-gaps--gotchas) for why that matters.

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
| `make test` | Run the end-to-end test flow |
| `make vehicle-client` | Register + publish telemetry using the real vehicle-client simulator |
| `make shell` | Open a shell in the `data-api` container |
| `make connector-logs` | Tail nats-bigtable-connector logs |
| `make stop` | Stop containers (keeps volumes) |
| `make clean` | Stop containers, remove volumes **and** the generated `.env` files |
| `make help` | Print the full command list |

Finer-grained control: `make setup-auto` prepares everything, then bring
services up yourself:

```bash
docker compose -f docker-compose.infra.yml up -d
docker compose up -d
```

---

## 4. Service URLs & credentials

| Service | Endpoint | Notes |
|---------|----------|-------|
| **NATS** | `nats://localhost:4222` | NKey + auth-callout; HTTP monitor `http://localhost:8222` |
| **Keycloak** | `http://localhost:8080` (admin UI), `https://localhost:8443` | admin/admin · realm `nexus-sdv` |
| **Bigtable emulator** | `localhost:8086` | project `test-project`, instance `test-instance`, table `telemetry` |
| **Mosquitto (MQTT)** | `mqtt://localhost:1883` | topic base `telemetry/#`
| **Data API (gRPC)** | `localhost:9090` | plaintext; container listens on 8080 |
| **Registration** | `https://localhost:8444` | mTLS |
| **Telemetry Chart Service** | `http://localhost:8081` | Java REST + WebSocket API |
| **Frontend (Next.js)** | `http://localhost:3000` | Live charts UI (no auth required) |

### NATS built-in accounts (from generated `config/nats.conf`)

These are created by `setup-automated.sh` and are what you use for host-side
tooling. They **bypass** the JWT auth callout, so no Keycloak token is needed.

| User | Password | Permissions | Use for |
|------|----------|-------------|---------|
| `connector` | `connector-pass` | pub/sub on `telemetry.>`, `telemetry-generic.>`, `local.telemetry.>`, `scoring.>` | Subscribing/publishing telemetry from the host or nats-box |
| `app-user` | `app-pass` | (account `APP`) | Application-account connections |
| `auth-callout-service` | `auth-callout-pass` | (account `AUTH`) | The auth-callout service itself |

> These credentials are **local-dev only** and intentionally not secret — they
> live in the generated `config/nats.conf`. Never reuse them anywhere real.

---

## 5. Working with data

### The one thing to know first

> **Local dev now has a NATS → Bigtable writer.** A `wombat` (Redpanda Connect)
> based `nats-bigtable-connector` service subscribes to `telemetry-generic.>`
> and writes decoded protobuf messages into the Bigtable emulator. The loop
> closes: MQTT → data-converter → NATS → connector → Bigtable → Data API.
>
> `make ingest` remains available for manual seeding / debugging. The Bigtable
> emulator is still **in-memory**: a container restart wipes the table.
> `make ingest`/`make query` recreate the table + column families automatically.

This means there are **two independent things you can watch**:

- **The live NATS stream** — what the vehicle client / MQTT actually publish
  ([Inspect live NATS messages](#inspect-live-nats-messages)).
- **Bigtable rows** — what you put there by hand with `make ingest`
  ([Read telemetry](#read-telemetry-query)).

They are not connected in local dev. Don't expect NATS traffic to appear in
`make query`.

### Data model

Source of truth: `base-services/data-api/src/service/bigtable.go` and `time.go`.

- **Row key:** `<VIN>#<timestamp>`, timestamp format
  `2006-01-02T15:04:05.000000000Z07:00` —
  e.g. `VIN123#2026-07-13T17:00:00.000000000Z`.
  data-api scans a `<VIN>#<start>` .. `<VIN>#<end>` key range, so the `#` and
  the exact timestamp format matter.
- **Columns:** `<family>:<qualifier>`; family is `dynamic` or `static` —
  e.g. `dynamic:speed`, `static:make`. Values are stored as raw bytes.

### Write telemetry (ingest)

```bash
# One sample row (VIN123, timestamp = now) with dynamic + static columns
make ingest

# Custom VIN / timestamp
bash scripts/ingest-sample.sh MYVIN 2026-07-13T17:00:00.000000000Z

# Raw cbt inside the emulator container (mind the row-key format)
docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
  cbt -project test-project -instance test-instance set telemetry \
  "VIN123#$(date -u +%Y-%m-%dT%H:%M:%S.000000000Z)" \
  dynamic:speed=72 static:make=Ford
```

### Read telemetry (query)

```bash
# All rows (raw, via cbt)
make query

# A single row by full key
bash scripts/query-bigtable.sh "VIN123#2026-07-13T17:00:00.000000000Z"
```

### Inspect live NATS messages

NATS uses auth callout with **no anonymous access** — a credential-less
connection is rejected with `nats: Authorization Violation`. Use the built-in
`connector` account (see [NATS built-in accounts](#nats-built-in-accounts-from-generated-confignatsconf)),
which bypasses the callout and can read `telemetry.>`.

The easiest way, with nothing installed locally, is the `nats-box` image on the
`nexus-local` network:

```bash
# Subscribe to ALL telemetry subjects
docker run --rm --network nexus-local natsio/nats-box:latest \
  nats sub "telemetry.>" \
  --user connector --password connector-pass \
  --server nats://nats:4222
```

> Note: inside the network the host is `nats`, not `localhost` — so
> `--server nats://nats:4222`.

**Which subjects to watch.** The vehicle client publishes different subjects
depending on `--message-type`:

| Message type | Subject | Catch-all |
|--------------|---------|-----------|
| `telemetry` (default) | `telemetry.<VIN>.battery` | `telemetry.>` |
| `metrics_report` | `vehicle_reports.<VIN>` | `vehicle_reports.>` |

Watch both at once:

```bash
docker run --rm --network nexus-local natsio/nats-box:latest \
  nats sub "telemetry.>" "vehicle_reports.>" \
  --user connector --password connector-pass \
  --server nats://nats:4222
```

You can also publish a test message the same way:

```bash
docker run --rm --network nexus-local natsio/nats-box:latest \
  nats pub "telemetry.VIN123.battery" '{"soc":85.5}' \
  --user connector --password connector-pass \
  --server nats://nats:4222
```

**HTTP monitoring** (no auth, no tools needed):

```bash
curl http://localhost:8222/connz   # connections
curl http://localhost:8222/subsz   # subscriptions
curl http://localhost:8222/varz    # server stats
```

### Publish over MQTT

This exercises the `MQTT → data-converter → NATS` path (it does **not** reach
Bigtable). Requires `mosquitto_pub` on your host, or use the container form.

```bash
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
  -m '{"name":"temp","value":25.5,"unit":"C"}'
```

To see it arrive, subscribe on NATS ([above](#inspect-live-nats-messages)) in
another terminal first.

### Read via the Data API (gRPC)

`data-api` serves telemetry over gRPC at `localhost:9090` (plaintext; the
container's 8080 is remapped). It reads the same Bigtable rows above.

```bash
# The client imports generated protobuf code (data-api/api/gen/...) that is
# produced during the Docker build and is NOT committed. Generate the stubs
# first (protoc + protoc-gen-go/protoc-gen-go-grpc), the same step
# base-services/data-api/Dockerfile.local performs. Then:
go -C base-services/data-api run ./client -addr localhost:9090 -vin VIN123
```

The sample client requests data types `static:index`, `static:test_key`,
`dynamic:time_passed`, so ingest a row carrying those columns to see it return
data. `make query` (cbt) is the simplest read path and needs no toolchain.

### End-to-end test

```bash
make test
# or: bash scripts/test-local-flow.sh
```

---

## 6. Running the vehicle client

[`sample-clients/vehicle-client`](../sample-clients/vehicle-client) is a real
vehicle simulator: it registers with the registration server via mTLS,
authenticates with Keycloak, and publishes telemetry to NATS. Its own
`run-vehicle-client.sh` expects a GCP bootstrap env file and Secret Manager
access that don't exist locally, so use the local-dev wrapper, which supplies
all of that from the running stack:

```bash
make vehicle-client
# or with options (passed through to the underlying script):
bash scripts/run-vehicle-client.sh --vin VEHICLE001 --interval 5 --message-type telemetry
```

The wrapper generates a factory cert signed by local-dev's factory CA (the same
one `registration` trusts), stages the TLS cert files the client reads, forces
`PKI_STRATEGY=local`, and points `REGISTRATION_URL`/`KEYCLOAK_URL`/`NATS_URL` at
local-dev's host ports (`https://localhost:8444`, `http://localhost:8080`,
`nats://localhost:4222`).

**Requires:** the stack running (`make go`), plus `protoc` and `go` on `PATH`
(the wrapper adds `$(go env GOPATH)/bin` for you, but not `protoc` itself).

**What works:** cert generation → mTLS registration → operational cert issuance,
and the Keycloak JWT step. The client correctly receives back
`Keycloak URL: http://localhost:8080` / `NATS URL: nats://localhost:4222`.

See [Known gaps & gotchas](#9-known-gaps--gotchas) for the two things that can
still bite you here (Keycloak key rotation, and the X.509-vs-secret realm
mismatch).

---

## 6b. Frontend Dashboard (Live Charts)

The [Next.js frontend](../sample-clients/data-web-client) provides a live dashboard at **http://localhost:3000/device/<VIN>** showing real-time telemetry charts via WebSocket.

### Quick Start

```bash
# 1. Start the full stack (includes frontend)
cd local-dev
make go

# 2. Run vehicle client to generate live data
./scripts/run-vehicle-client.sh --vin VIN123 --message-type telemetry --interval 5

# 3. Open dashboard
open http://localhost:3000/device/VIN123
```

### Features

- **Live line charts** (Chart.js) updating every ~1 second via WebSocket
- **Historical data** on initial load (last hour by default)
- **Time range selector** (1h, 6h, 24h, 7d)
- **Data table** with pagination and column sorting
- **Multiple sensors** as separate lines on the same chart
- **GPS track map** (when GPS data available)

### Architecture

\`\`\`
Frontend (Next.js:3000) → API Proxy (/api/telemetry/[vin]) → Java Service (REST:8081)
                                      │
                                      └── WebSocket (/ws/telemetry) → Java Service (WS:8081)
\`\`\`

The frontend proxies API calls to the Java telemetry-chart-service (port 8081) and establishes a WebSocket connection for live updates. No authentication is required for the device pages.

---



## 7. Build model (Dockerfile.local & proto)

`data-api` and `data-converter` build with the **repo root** as their Docker
build context (see `docker-compose.yml`), so their Dockerfiles generate Go
protobuf/gRPC stubs directly from the shared `../proto/*.proto` files at build
time. Nothing under `proto/` is copied into a service by hand, and there is no
generated code to commit — `docker compose build` (or `make go`) regenerates
stubs fresh every time.

Every service builds from a **`Dockerfile.local`** sitting next to its regular
`Dockerfile` (see the `dockerfile:` key per service in `docker-compose.yml`).
The GCP-deployed image is still built from the original `Dockerfile`, untouched
by local-dev. The two files exist so local-dev concerns (a public-registry
default for `DOCKER_HUB_MIRROR`, protobuf generation) never affect what gets
deployed to GCP.

> **Do not edit a service's `Dockerfile` to fix a local-dev-only problem** —
> put the fix in `Dockerfile.local` instead.

---

## 8. Environment files

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

## 9. Known gaps & gotchas

| Gap / gotcha | Impact | What to do |
|--------------|--------|------------|
| **NATS → Bigtable writer** | `nats-bigtable-connector` persists both `telemetry.{VIN}` and `telemetry-generic.{VIN}.{sensor}` into Bigtable | Smoke-tested by `make test` (Tests 4–5) |
| **Bigtable emulator is in-memory** | Table wiped on container restart | Re-run `make ingest` (it recreates table + families) |
| **Anonymous NATS is denied** | `nats sub`/`pub` with no creds → `Authorization Violation` | Use `--user connector --password connector-pass` |
| **Keycloak key rotation** | See below — vehicle-client fails at the NATS step after a restart | `make clean && make go` (fix now persists keys) |
| **Vehicle-client Keycloak realm mismatch** | See below | Resolved: per-VIN client `VIN123` (secret from realm via jq) — `make vehicle-client` works end to end |
| **Running vehicle client directly fails with TLS error** | `remote error: tls: error decrypting message` | Must use local-dev wrapper: `make vehicle-client` or `bash scripts/run-vehicle-client.sh` — do NOT run `sample-clients/vehicle-client/run-vehicle-client.sh` directly |

### Keycloak key rotation (the "worked yesterday, broken today" one)

Auth Callout validates Keycloak JWTs against a **one-time JWKS snapshot** taken
at setup (`setup-automated.sh` → `phase_keycloak_jwks` → `KEYCLOAK_JWK_B64`,
parsed once at `base-services/auth-callout/main.go` startup — it never
refetches). If Keycloak regenerates its realm signing key, every fresh JWT has a
new `kid` that the snapshot doesn't know, so Auth Callout rejects it and NATS
returns `Authorization Violation` — even though registration and JWT issuance
both succeeded.

`docker-compose.infra.yml` now gives Keycloak a **persistent
`keycloak-data` volume** so its signing keys survive restarts and the snapshot
stays valid. To activate it after pulling this change (the previously-rotated
key is already stale):

```bash
make clean && make go
```

Quick unblock without a full rebuild — re-snapshot the JWKS and restart just
auth-callout:

```bash
make setup-auto
docker compose --env-file .env.base-services --env-file .env.sample-services \
  up -d --force-recreate auth-callout
```

### Vehicle-client Keycloak realm mismatch
 `remote error: tls: error decrypting message` | Must use local-dev wrapper: `make vehicle-client` or `bash scripts/run-vehicle-client.sh` — do NOT run `sample-clients/vehicle-client/run-vehicle-client.sh` directly |

`vehicle-client`'s Go code historically hardcoded realm `sdv-telemetry` /
`client_id=car` with **X.509 client-cert** auth (no secret). local-dev's
imported realm is `nexus-sdv` with a **client-secret** `vehicle-client`. The
local wrapper (`scripts/run-vehicle-client.sh`) overrides
`KEYCLOAK_REALM`/`KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` (reading the
secret out of the realm import via `jq`) to bridge this. Full X.509-authenticator
support in Keycloak (trust store, execution flow, cert-to-user mapping) remains a
separate, larger piece of work.

---

## 10. Troubleshooting

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
docker network inspect nexus-local           # network wiring
```

**Full reset:** `make clean && make go`.

---

## 11. File structure

```
local-dev/
├── Makefile                  # All commands ('make help')
├── README.md                 # This file
├── ARCHITECTURE.md           # System design, data flow, diagrams
├── go.sh                     # Entry point for 'make go'
├── setup-automated.sh        # 10-phase automated setup pipeline
├── docker-compose.yml        # App services
├── docker-compose.infra.yml  # Infrastructure (+ keycloak-data volume)
├── docker-compose.certs.yml  # Cert generation
├── certs/                    # Generated certificates (gitignored)
│   ├── ca/  registration/  nats/  keycloak/
├── config/                   # Runtime configs
│   ├── nats.conf             # Generated by setup-automated.sh (has the connector user)
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

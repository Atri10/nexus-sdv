# Nexus SDV Local Development Environment

Complete local development setup with all infrastructure and application services running in Docker. Fully automated — one command generates certs, keys, tokens, and starts everything.

## Quick Start

```bash
cd local-dev
make go
```

This runs `setup-automated.sh` (first time only) and starts every service. No manual token copying, no hardcoded secrets — TLS certs, the NATS NKey pair, and the Keycloak JWKS token are all generated and injected automatically. Takes about 2-3 minutes on a first run.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together and what each setup phase does.

## Architecture

### Infrastructure Services (docker-compose.infra.yml)
- **NATS** (`localhost:4222`) - Message broker with auth callout
- **Keycloak** (`localhost:8080`) - Identity provider (admin/admin)
- **Bigtable Emulator** (`localhost:8086`) - Google Cloud Bigtable mock
- **Mosquitto** (`localhost:1883`) - MQTT broker

### Application Services (docker-compose.yml)
- **Data API** (`localhost:9090`) - gRPC telemetry service
- **Auth Callout** - NATS authentication service
- **Data Converter** - MQTT → NATS → Bigtable pipeline
- **Registration** (`localhost:8444`) - Vehicle certificate registration
- **Data API Sampler** - Sample data generator
- **Trip Analyzer** - Trip analysis service

`data-api` and `data-converter` build with the repo root as their Docker build context (see `local-dev/docker-compose.yml`), so their Dockerfiles can generate Go protobuf/gRPC stubs directly from the shared `../proto/*.proto` files at build time. Nothing under `proto/` needs to be copied into a service directory by hand, and there's no generated code to commit — `docker compose build` (or `make go`) regenerates the stubs fresh every time.

### `Dockerfile.local`

Every service builds from a `Dockerfile.local` sitting next to its regular `Dockerfile` (see the `dockerfile:` key for each service in `local-dev/docker-compose.yml`). The GCP-deployed image is still built from the original `Dockerfile`, untouched by local-dev — the two files exist so local-dev concerns (a public-registry default for `DOCKER_HUB_MIRROR` instead of the internal GCP Artifact Registry mirror, protobuf generation for `data-api`/`data-converter`) never risk affecting what actually gets deployed to GCP. If a service's local-dev build genuinely doesn't need to differ from its GCP build, its `Dockerfile.local` is still kept as a full copy for consistency and so every service is built the same way locally, rather than mixing `dockerfile: Dockerfile` and `dockerfile: Dockerfile.local` across the compose file.

Do not edit a service's `Dockerfile` to fix a local-dev-only problem — add the fix to `Dockerfile.local` instead.

## Usage

```bash
make go       # First-time setup + start everything (recommended)
make logs     # Tail all logs
make ingest   # Write a sample telemetry row into Bigtable
make query    # Query Bigtable telemetry data
make test     # Run end-to-end test flow
make stop     # Stop all containers (keeps volumes)
make clean    # Stop containers and remove volumes + env files
make status   # Show service health
make shell    # Shell into the data-api container
make help     # Full command list
```

If you need finer-grained control, `make setup-auto` runs just the automated setup (certs, keys, tokens, env files) without starting services — you can then bring services up yourself with `docker compose -f docker-compose.infra.yml up -d` followed by `docker compose up -d`.

### Reading & Writing Telemetry Data

> **Important:** local dev has **no NATS → Bigtable writer.** `data-converter`
> only forwards MQTT → NATS, and `make vehicle-client` only publishes to NATS —
> nothing consumes those messages into Bigtable. So `make query` returns nothing
> until you write rows yourself. The Bigtable emulator is also **in-memory**: a
> container restart (Docker restart / laptop sleep) wipes the table. The ingest
> and query scripts recreate the table + column families automatically, so you
> just re-run `make ingest` after a restart.

#### Data model

`data-api` and the query tool expect this exact layout (source of truth:
`base-services/data-api/src/service/bigtable.go` and `time.go`):

- **Row key:** `<VIN>#<timestamp>`, where the timestamp uses the format
  `2006-01-02T15:04:05.000000000Z07:00` — e.g. `VIN123#2026-07-13T17:00:00.000000000Z`.
  data-api scans by a `<VIN>#<start>` .. `<VIN>#<end>` key range, so the `#` and
  the timestamp format matter.
- **Columns:** `<family>:<qualifier>`, family is `dynamic` or `static` —
  e.g. `dynamic:speed`, `static:make`. Values are stored as raw bytes.

#### Ingest (write rows)

```bash
# Write one sample row (VIN123, timestamp = now) with dynamic + static columns
make ingest

# Custom VIN / timestamp
bash scripts/ingest-sample.sh MYVIN 2026-07-13T17:00:00.000000000Z

# Or raw cbt, run inside the emulator container (note the row-key format)
docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
  cbt -project test-project -instance test-instance set telemetry \
  "VIN123#$(date -u +%Y-%m-%dT%H:%M:%S.000000000Z)" \
  dynamic:speed=72 static:make=Ford
```

#### Read rows

```bash
# All rows (raw, via cbt)
make query

# A single row by full key
bash scripts/query-bigtable.sh "VIN123#2026-07-13T17:00:00.000000000Z"

# Service logs
make logs
docker compose logs data-converter
docker compose logs data-api
```

#### Reading via the data-api gRPC service

`data-api` serves telemetry over gRPC at `localhost:9090` (plaintext; the
container listens on 8080, remapped to 9090). It reads the same Bigtable rows
above and is what platform consumers call. A minimal Go client lives at
`base-services/data-api/client/main.go`:

```bash
# NOTE: the client imports generated protobuf code (data-api/api/gen/...) that
# is produced during the Docker build and is NOT committed, so it isn't present
# on the host by default. To run the client locally you must generate the stubs
# first (protoc + protoc-gen-go/protoc-gen-go-grpc), the same step
# base-services/data-api/Dockerfile.local performs. Once generated:
go -C base-services/data-api run ./client -addr localhost:9090 -vin VIN123
```

The sample client requests data types `static:index`, `static:test_key`,
`dynamic:time_passed`, so ingest a row carrying those columns to see it return
data. `make query` (cbt) is the simplest read path and needs no toolchain.

### Test End-to-End Flow

```bash
make test
# or: bash scripts/test-local-flow.sh
```

### Run the Vehicle Client

[`sample-clients/vehicle-client`](../sample-clients/vehicle-client) is a real vehicle simulator: it registers with the registration server via mTLS, authenticates with Keycloak, and publishes telemetry to NATS. Its own `run-vehicle-client.sh` expects a GCP bootstrap env file and Secret Manager access that don't exist locally, so use the local-dev wrapper instead, which supplies all of that from the running stack:

```bash
make vehicle-client
# or with options (passed through to the underlying script):
bash scripts/run-vehicle-client.sh --vin VEHICLE001 --interval 5 --message-type telemetry
```

This generates a factory certificate signed by local-dev's factory CA (the same one `registration` trusts), stages the TLS cert files the client reads, and forces `PKI_STRATEGY=local` with `REGISTRATION_URL`/`KEYCLOAK_URL`/`NATS_URL` pointed at local-dev's host ports (`https://localhost:8444`, `http://localhost:8080`, `nats://localhost:4222`) instead of a `*.nexus-sdv.io` hostname. Requires the stack to already be running (`make go`), and `protoc`/`go` on `PATH` (the wrapper adds `$(go env GOPATH)/bin` for you, but not `protoc` itself).

**Verified working:** cert generation → mTLS registration → operational certificate issuance. The client correctly receives back `Keycloak URL: http://localhost:8080` / `NATS URL: nats://localhost:4222` from registration, proving the URL-override fix above works end-to-end.

**Known gap:** the Keycloak step after that fails. `vehicle-client`'s Go code hardcodes realm `sdv-telemetry` and `client_id=car`, and authenticates purely via mTLS client certificate (no secret) — local-dev's imported realm (`local-dev/keycloak/nexus-realm.json`) is named `nexus-sdv` and its `vehicle-client` entry uses `client-secret` auth, not X.509 client-cert auth. Fixing this needs real Keycloak X.509-authenticator configuration (trust store, execution flow, cert-to-user mapping) — a separate, larger piece of work, not just a naming fix.

## Environment Files

Three `.env` files are generated automatically by `setup-automated.sh` — never edited by hand:

- `.env.infra` - Infrastructure credentials (NATS NKey, Keycloak admin, etc.)
- `.env.base-services` - Base services config (signing keys, service URLs)
- `.env.sample-services` - Sample services config

These are gitignored and contain secrets — do not commit them.

## Service URLs & Credentials

### Keycloak
- Admin UI: https://localhost:8080
- Default credentials: `admin` / `admin`
- Realm: `nexus-sdv`
- Client: `vehicle-client`

### NATS
- URL: `nats://localhost:4222`
- HTTP Monitoring: `http://localhost:8222`
- NKey Auth enabled

### Bigtable
- Host: `localhost:8086`
- Project: `test-project`
- Instance: `test-instance`
- Table: `telemetry`

### APIs
- Data API gRPC: `grpc://localhost:9090`
- Registration HTTPS: `https://localhost:8444`
- Mosquitto MQTT: `mqtt://localhost:1883`

## Troubleshooting

### Containers not starting
```bash
docker compose logs auth-callout
docker compose -f docker-compose.infra.yml logs keycloak

# Rebuild images (clears cache)
docker compose build --no-cache
```

### Network errors
```bash
docker network create nexus-local
docker network ls
```

### Port conflicts
- Data API: 9090 (internal 8080)
- Registration: 8444 (internal 8443)
- Keycloak: 8080, 8443
- NATS: 4222, 8222
- Mosquitto: 1883, 8883

### Bigtable issues
```bash
docker compose logs bigtable-emulator
make query
```
`make query` runs `cbt` inside the `bigtable-emulator` container (installing it as a gcloud component on first use). `setup-automated.sh`'s `phase_bigtable_schema` creates the `telemetry` table with `dynamic` and `static` column families (the same schema `data-api`'s integration tests bootstrap) right after infra comes up, so a `table ... not found` error means that phase didn't run — re-run `make setup-auto` or check its output.

`make query` returning no rows is expected on a fresh environment even once the table exists: **nothing in local dev currently writes telemetry into Bigtable** (there is no NATS → Bigtable writer — see [Reading & Writing Telemetry Data](#reading--writing-telemetry-data)). Write a row yourself with `make ingest`, then `make query`. Because the emulator is in-memory, a container restart also empties the table — just re-run `make ingest` (it recreates the table + families first).

### Full reset
```bash
make clean && make go
```

## File Structure

```
local-dev/
├── Makefile                  # All commands ('make help')
├── README.md                 # This file
├── ARCHITECTURE.md           # System design, data flow, diagrams
├── go.sh                     # Entry point for 'make go'
├── setup-automated.sh        # 10-phase automated setup pipeline
├── docker-compose.yml        # App services
├── docker-compose.infra.yml  # Infrastructure
├── docker-compose.certs.yml  # Cert generation
├── certs/                    # Generated certificates (gitignored)
│   ├── ca/
│   ├── registration/
│   ├── nats/
│   ├── keycloak/
│   └── clients/
├── config/                   # Service configs
│   ├── nats.conf            # Generated by setup-automated.sh
│   ├── mosquitto.conf
│   └── data-converter.yaml
├── configs/                   # Env file templates (source of truth for defaults)
│   ├── infra.template
│   ├── base-services.template
│   └── sample-services.template
├── keycloak/
│   └── nexus-realm.json     # Realm import
└── scripts/
    ├── generate-certs.sh      # Run inside the cert-generator container (docker-compose.certs.yml)
    ├── ingest-sample.sh       # Write a sample telemetry row into Bigtable
    ├── query-bigtable.sh      # Bigtable query tool
    ├── run-vehicle-client.sh  # Wrapper for sample-clients/vehicle-client
    ├── test-local-flow.sh     # End-to-end test
    └── wait-for-services.sh   # Health check polling
```

## Data Flow

```
Vehicle/Sensor → Mosquitto (MQTT) → Data Converter → NATS → Bigtable
                                                       ↓
                                                  Auth Callout
                                                       ↓
                                                   Keycloak JWT

Telemetry Query → Data API (gRPC) → Bigtable
```

## Development Tips

1. **Watch service logs in real-time:**
   ```bash
   docker compose logs -f data-converter
   ```

2. **Execute commands in running container:**
   ```bash
   docker compose exec data-api /bin/sh
   ```

3. **Rebuild a specific service:**
   ```bash
   docker compose build --no-cache data-api
   docker compose up -d data-api
   ```

4. **Push test telemetry (requires mosquitto_pub):**
   ```bash
   mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
     -m '{"name":"temp","value":25.5,"unit":"C"}'
   ```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| `network nexus-local not found` | Run `docker network create nexus-local` |
| Port already in use | Change port in docker-compose file or stop conflicting service |
| Keycloak cert errors | `make clean && make go` to regenerate |
| NATS auth failures | Check `.env.infra` for correct NKey values |
| Bigtable not responding | Wait 30s for emulator to start, check `docker compose logs bigtable-emulator` |
| Build failures | `docker builder prune` then `make clean && make go` |

## Monitoring & Debugging

```bash
# NATS connections and subscriptions
curl http://localhost:8222/connz
curl http://localhost:8222/subsz

# Keycloak health
curl http://localhost:8080/health/ready

# Container health
docker compose ps

# Network inspection
docker network inspect nexus-local
```

## Support

1. Check logs: `make logs`
2. Inspect environment: `docker compose config`
3. Review service health: `make status`
4. Full reset: `make clean && make go`

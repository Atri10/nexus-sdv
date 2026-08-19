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

## Usage

```bash
make go       # First-time setup + start everything (recommended)
make logs     # Tail all logs
make query    # Query Bigtable telemetry data
make test     # Run end-to-end test flow
make stop     # Stop all containers (keeps volumes)
make clean    # Stop containers and remove volumes + env files
make status   # Show service health
make shell    # Shell into the data-api container
make help     # Full command list
```

If you need finer-grained control, `make setup-auto` runs just the automated setup (certs, keys, tokens, env files) without starting services — you can then bring services up yourself with `docker compose -f docker-compose.infra.yml up -d` followed by `docker compose up -d`.

### Inspect Data

```bash
# Query Bigtable telemetry data
make query

# Query specific row
bash scripts/query-bigtable.sh "VIN123/2026-07-13"

# View service logs
make logs
docker compose logs data-converter
docker compose logs data-api
```

### Test End-to-End Flow

```bash
make test
# or: bash scripts/test-local-flow.sh
```

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

`make query` returning no rows is expected on a fresh environment even once the table exists: **nothing in local dev currently writes telemetry into Bigtable**. `data-converter` only forwards MQTT → NATS; there is no NATS → Bigtable writer running locally, so `data-api` has nothing to read unless you write rows yourself, e.g.:
```bash
docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
  cbt -project test-project -instance test-instance set telemetry \
  "VIN123#$(date -u +%Y-%m-%dT%H:%M:%S.000000000Z)" dynamic:temp=25.5
```

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
    ├── generate-certs.sh     # Run inside the cert-generator container (docker-compose.certs.yml)
    ├── query-bigtable.sh     # Bigtable query tool
    ├── test-local-flow.sh    # End-to-end test
    └── wait-for-services.sh  # Health check polling
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

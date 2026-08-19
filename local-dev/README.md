# Nexus SDV Local Development Environment

Complete local development setup with all infrastructure and application services running in Docker.

## Quick Start (Single Command)

```bash
cd local-dev
make setup
make start
```

Or use the all-in-one setup script:
```bash
bash scripts/setup-all.sh
```

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

## Usage

### Setup Commands

```bash
# One-time initial setup (generates certs, configs, networks)
make setup

# Or individual steps:
bash scripts/setup-local-dev.sh      # Generate certs
bash scripts/generate-nkeys.sh       # Generate NATS NKey
bash scripts/generate-nats-config.sh # Generate NATS config
```

### Start Services

```bash
# Start everything (infrastructure + services)
make start

# Or in stages:
make infra                # Start infrastructure only
make services             # Start application services

# Start with output
docker compose logs -f
```

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
# Run test flow (vehicle registration, token generation, telemetry)
make test

# Or manually:
bash scripts/test-local-flow.sh
```

### Cleanup

```bash
# Stop all containers (keep volumes/data)
make stop

# Stop and remove all volumes
make clean

# Remove only app services (keep infrastructure)
docker compose down
```

## Environment Files

Three `.env` files are automatically created during setup:

- `.env.infra` - Infrastructure credentials (NATS, Keycloak, etc.)
- `.env.base-services` - Base services config (keys, URLs)
- `.env.sample-services` - Sample services config

**These files contain secrets - do NOT commit to Git**

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
# Check logs for specific service
docker compose logs auth-callout
docker compose logs -f docker-compose.infra.yml keycloak

# Rebuild images (clears cache)
docker compose build --no-cache
```

### Network errors
```bash
# Ensure network exists
docker network create nexus-local

# List networks
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
# Check if emulator is healthy
docker compose logs bigtable-emulator

# Try querying:
make query
```

## File Structure

```
local-dev/
├── Makefile                          # Quick command shortcuts
├── README.md                         # This file
├── setup-all.sh                      # All-in-one setup
├── docker-compose.yml                # App services
├── docker-compose.infra.yml          # Infrastructure
├── docker-compose.certs.yml          # Cert generation
├── certs/                            # Generated certificates
│   ├── ca/                          # Root CA
│   ├── registration/                # Registration server certs
│   ├── nats/                        # NATS server certs
│   ├── keycloak/                    # Keycloak certs + JWKS
│   └── clients/                     # Client certificates
├── config/                           # Service configs
│   ├── nats.conf                    # NATS config (generated)
│   ├── mosquitto.conf               # Mosquitto config
│   └── data-converter.yaml          # Data converter pipeline
├── keycloak/                        # Keycloak realm imports
│   └── nexus-realm.json            # Realm config
└── scripts/
    ├── setup-local-dev.sh           # Initial setup
    ├── generate-certs.sh            # Cert generation
    ├── generate-nkeys.sh            # NATS NKey generation
    ├── generate-nats-config.sh      # NATS config generation
    ├── start-infra.sh               # Start infrastructure
    ├── start-services.sh            # Start app services
    ├── generate-keycloak-jwks.sh    # Extract Keycloak JWKS
    ├── test-local-flow.sh           # End-to-end test
    ├── wait-for-services.sh         # Health check
    └── query-bigtable.sh            # Bigtable query tool
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

3. **View environment variables:**
   ```bash
   docker compose config | grep -A 20 "auth-callout:"
   ```

4. **Rebuild a specific service:**
   ```bash
   docker compose build --no-cache data-api
   docker compose up -d data-api
   ```

5. **Push test telemetry:**
   ```bash
   # Requires mosquitto_pub or similar MQTT client
   mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
     -m '{"name":"temp","value":25.5,"unit":"C"}'
   ```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| `network nexus-local not found` | Run `docker network create nexus-local` |
| Port already in use | Change port in docker-compose file or stop conflicting service |
| Keycloak cert errors | Regenerate certs: `make clean && make setup` |
| NATS auth failures | Check `.env.infra` for correct NKey values |
| Bigtable not responding | Wait 30s for emulator to start, check health: `docker compose logs bigtable-emulator` |
| Build failures | Clear cache: `docker builder prune && make clean` |

## Monitoring & Debugging

### NATS Monitoring
```bash
# View NATS connections and subscriptions
curl http://localhost:8222/connz
curl http://localhost:8222/subsz
```

### Keycloak Health
```bash
curl http://localhost:8080/health/ready
```

### Container Health
```bash
docker compose ps  # Shows health status
```

### Network Inspection
```bash
docker network inspect nexus-local
docker network inspect docker-compose logs
```

## Next Steps

- Deploy to Kubernetes (see `k8s/` directory)
- Configure external services (real Bigtable, Cloud Keycloak)
- Add custom protobuf definitions
- Integrate with CI/CD pipeline

## Support

For issues or questions:
1. Check logs: `make logs`
2. Inspect environment: `docker compose config`
3. Review service health: `docker compose ps`
4. Check setup state: `ls -la local-dev/certs/ local-dev/.env*`

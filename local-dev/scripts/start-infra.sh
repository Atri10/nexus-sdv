#!/bin/bash
# local-dev/scripts/start-infra.sh
# Start infrastructure services

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[start-infra]\033[0m $*"; }

log "Generating NATS config with current NKey..."
./scripts/generate-nats-config.sh

log "Starting infrastructure..."
docker compose -f docker-compose.infra.yml --env-file configs/infra.template up -d

log "Waiting for infrastructure to be healthy..."
./scripts/wait-for-services.sh

log "Infrastructure started!"
echo "  NATS: nats://localhost:4222"
echo "  Keycloak: https://localhost:8443"
echo "  Bigtable: localhost:8086"
echo "  Mosquitto: localhost:1883"
echo ""
echo "Next: Run ./scripts/generate-keycloak-jwks.sh to extract JWKS from Keycloak"
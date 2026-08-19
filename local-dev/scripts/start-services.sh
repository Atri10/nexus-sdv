#!/bin/bash
# local-dev/scripts/start-services.sh
# Start application services

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[start-services]\033[0m $*"; }

log "Starting application services..."
docker compose --env-file configs/base-services.template --env-file configs/sample-services.template up -d

log "Waiting for services to be healthy..."
"$SCRIPTS_DIR/wait-for-services.sh"

log "All services started!"
echo "  auth-callout: connected to NATS"
echo "  data-api: grpc://localhost:8080"
echo "  registration: https://localhost:8443"
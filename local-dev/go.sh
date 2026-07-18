#!/bin/bash
# local-dev/go.sh
# Ultra-fast one-command setup and start

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
cd "$SCRIPTS_DIR"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}▶${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }

# Check if already setup
if [ -f ".env.infra" ]; then
    log "Services already configured, starting..."
    # docker-compose.infra.yml owns and creates the nexus-local network (see
    # its 'networks:' block); bring infra up first so the network exists with
    # the compose labels docker-compose.yml's 'external: true' expects, even
    # if it was removed manually since the last run.
    docker compose -f docker-compose.infra.yml --env-file .env.infra up -d
else
    log "First run detected - running automated setup..."
    bash setup-automated.sh || exit 1
fi

log "Bringing all services online..."
docker compose --env-file .env.base-services --env-file .env.sample-services up -d

log "Waiting for all services to be ready..."
sleep 5

log "========================================="
info "✓ All services online and ready to use!"
info "✓ No manual setup needed - everything automatic!"
log "========================================="
echo ""

# Show quick reference
info "Quick commands:"
echo "  make logs              # Watch all logs"
echo "  make query             # View Bigtable data"
echo "  make test              # Run integration tests"
echo "  docker compose ps      # Check service status"
echo "  make stop              # Stop all services"
echo ""

info "Service URLs:"
echo "  NATS:            nats://localhost:4222"
echo "  Keycloak:        http://localhost:8080 (admin/admin)"
echo "  Bigtable:        localhost:8086"
echo "  Mosquitto:       localhost:1883"
echo "  Data API:        grpc://localhost:9090"
echo "  Registration:    https://localhost:8444"
echo "  Telemetry Charts: http://localhost:8081"
echo "  Frontend:        http://localhost:3000"

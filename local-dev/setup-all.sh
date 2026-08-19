#!/bin/bash
set -euo pipefail

# local-dev/setup-all.sh
# One-command setup for complete local development environment

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[setup]${NC} $*"; }
info() { echo -e "${BLUE}[info]${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*"; return 1; }

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR"

cd "$LOCAL_DEV_DIR"

log "========================================="
log "Nexus SDV Local Development Setup"
log "========================================="

# Step 1: Generate certificates
log "Step 1: Generating certificates..."
docker compose -f docker-compose.certs.yml up cert-generator

# Step 2: Generate NKey
log "Step 2: Generating NATS NKey..."
./scripts/generate-nkeys.sh

# Step 3: Generate NATS config
log "Step 3: Generating NATS config..."
./scripts/generate-nats-config.sh

# Step 4: Create env files
log "Step 4: Creating environment files..."
cp configs/infra.template .env.infra
cp configs/base-services.template .env.base-services
cp configs/sample-services.template .env.sample-services
info ".env.infra, .env.base-services, and .env.sample-services created"

# Step 5: Create network
log "Step 5: Creating Docker network..."
docker network create nexus-local 2>/dev/null || info "Network nexus-local already exists"

# Step 6: Start infrastructure
log "Step 6: Starting infrastructure services..."
docker compose -f docker-compose.infra.yml --env-file .env.infra up -d

# Step 7: Wait for infrastructure
log "Step 7: Waiting for infrastructure to be healthy..."
./scripts/wait-for-services.sh

# Step 8: Generate Keycloak JWKS
log "Step 8: Generating Keycloak JWKS..."
./scripts/generate-keycloak-jwks.sh > /dev/null

# Step 9: Start application services
log "Step 9: Starting application services..."
docker compose --env-file .env.base-services --env-file .env.sample-services up -d

# Step 10: Wait for all services
log "Step 10: Waiting for all services to be healthy..."
./scripts/wait-for-services.sh

log "========================================="
log "✓ Setup Complete!"
log "========================================="
echo ""
info "Infrastructure Services:"
echo "  • NATS: nats://localhost:4222"
echo "  • Keycloak: https://localhost:8080 (admin/admin)"
echo "  • Bigtable Emulator: localhost:8086"
echo "  • Mosquitto: localhost:1883"
echo ""
info "Application Services:"
echo "  • Data API: grpc://localhost:8080"
echo "  • Registration: https://localhost:8443"
echo "  • Auth Callout: connected to NATS"
echo ""
info "Next Steps:"
echo "  1. View logs: docker compose logs -f <service>"
echo "  2. Test local flow: ./scripts/test-local-flow.sh"
echo "  3. Query Bigtable: ./scripts/query-bigtable.sh"
echo "  4. Cleanup: docker compose down"

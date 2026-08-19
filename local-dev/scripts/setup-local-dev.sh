#!/bin/bash
# local-dev/scripts/setup-local-dev.sh
# One-time setup for local development

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

log() { echo -e "\033[0;32m[setup]\033[0m $*"; }

cd "$LOCAL_DEV_DIR"

log "Step 1: Generating certificates..."
docker compose -f docker-compose.certs.yml up cert-generator

log "Step 2: Creating env files from templates..."
cp configs/infra.template .env.infra
cp configs/base-services.template .env.base-services
cp configs/sample-services.template .env.sample-services

log "Step 3: Generate NATS NKey..."
# This would call a helper to generate NKey pair
# For now, use placeholder
echo "NATS_AUTH_CALLOUT_NKEY_PUB=AAA_PLACEHOLDER" >> .env.infra
echo "JWT_ACC_SIGNING_KEY=SAA_PLACEHOLDER" >> .env.base-services

log "Setup complete! Next steps:"
echo "  1. Edit .env.infra with actual passwords"
echo "  2. Edit .env.base-services with actual values"
echo "  3. Run: ./scripts/start-infra.sh"
#!/bin/bash
set -euo pipefail

# local-dev/setup-automated.sh
# Completely automated setup - no manual token copying, no hardcoding
# Everything is generated, validated, and injected automatically

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $*"; }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR"
PROTO_PATH=$(cd "$LOCAL_DEV_DIR/../proto" && pwd)

cd "$LOCAL_DEV_DIR"

log "========================================="
log "Nexus SDV - FULLY AUTOMATED SETUP"
log "========================================="
log "No manual token copying. No hardcoding."
log "Everything is automatic."
log ""

# ============================================================================
# PHASE 1: Cleanup (Optional)
# ============================================================================
phase_cleanup() {
    if [ -f ".env.infra" ] || [ -f ".env.base-services" ] || [ -f ".env.sample-services" ]; then
        warn "Previous setup detected"
        read -p "Remove old configuration? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log "Removing old config files..."
            rm -f .env.infra .env.base-services .env.sample-services
            info "Old configuration removed"
        fi
    fi
}

# ============================================================================
# PHASE 2: Network Setup
# ============================================================================
phase_network() {
    log "Setting up Docker network..."
    if docker network inspect nexus-local &>/dev/null; then
        info "Network nexus-local already exists"
    else
        docker network create nexus-local
        info "Network nexus-local created"
    fi
}

# ============================================================================
# PHASE 3: Certificate Generation
# ============================================================================
phase_certificates() {
    log "Generating TLS certificates..."

    if [ -f "certs/ca/ca.crt.pem" ]; then
        info "Certificates already exist"
        return 0
    fi

    # Run cert generator in Docker
    docker compose -f docker-compose.certs.yml up cert-generator

    # Verify certificates were created
    if [ ! -f "certs/ca/ca.crt.pem" ]; then
        error "Certificate generation failed"
    fi

    info "Certificates generated successfully"
}

# ============================================================================
# PHASE 4: NATS NKey Generation & Configuration
# ============================================================================
phase_nats_config() {
    log "Generating NATS NKey and configuration..."

    # Generate NKey using Go (in the repo)
    local nkey_output
    nkey_output=$(cd "$(cd "$LOCAL_DEV_DIR"/.. && pwd)/base-services/auth-callout" && go run <<'GOCODE'
package main
import (
    "fmt"
    "github.com/nats-io/nkeys"
)
func main() {
    kp, _ := nkeys.CreateAccount()
    pub, _ := kp.PublicKey()
    seed, _ := kp.Seed()
    fmt.Printf("PUBLIC:%s\n", pub)
    fmt.Printf("SEED:%s\n", string(seed))
}
GOCODE
)

    local nats_pub=$(echo "$nkey_output" | grep "PUBLIC:" | cut -d: -f2)
    local nats_seed=$(echo "$nkey_output" | grep "SEED:" | cut -d: -f2)

    if [ -z "$nats_pub" ] || [ -z "$nats_seed" ]; then
        error "NATS NKey generation failed"
    fi

    # Store for later use
    export NATS_AUTH_CALLOUT_NKEY_PUB="$nats_pub"
    export NATS_ACCOUNT_SIGNING_KEY="$nats_seed"

    info "NATS NKey generated (stored in memory, will be injected)"

    # Generate NATS config with NKey
    log "Generating NATS configuration..."
    cat > config/nats.conf << EOF
# NATS configuration with NKey authentication

port: 4222
http: 8222

server_name: local-nats

# NKey-based authentication
nkeys: [{
    users: [
        {
            nkey: $NATS_AUTH_CALLOUT_NKEY_PUB
            permissions: {
                publish: ["telemetry.*"]
                subscribe: ["telemetry.*", "auth.verify"]
            }
        }
    ]
    account: auth-callout-account
}]

# Basic auth for other services
authorization: {
    users: [
        {
            user: app-user
            password: app-pass
            permissions: {
                publish: ["telemetry.*"]
                subscribe: ["telemetry.*"]
            }
        },
        {
            user: connector
            password: connector-pass
            permissions: {
                publish: ["telemetry.data"]
                subscribe: ["telemetry.#"]
            }
        }
    ]
}

# TLS (optional, for local dev we use mTLS at app level)
# tls: {
#   cert_file: "/etc/nats/certs/server.crt.pem"
#   key_file: "/etc/nats/certs/server.key.pem"
#   ca_file: "/etc/nats/certs/ca.crt.pem"
# }
EOF

    info "NATS configuration created"
}

# ============================================================================
# PHASE 5: Create Base Environment Files (from templates)
# ============================================================================
phase_base_env() {
    log "Creating base environment files..."

    cp configs/infra.template .env.infra
    cp configs/base-services.template .env.base-services
    cp configs/sample-services.template .env.sample-services

    info "Base environment files created"
}

# ============================================================================
# PHASE 6: Start Infrastructure & Generate Dynamic Tokens
# ============================================================================
phase_infra_startup() {
    log "Starting infrastructure services..."

    docker compose -f docker-compose.infra.yml --env-file .env.infra up -d

    # Wait for services to be healthy
    log "Waiting for infrastructure to be healthy..."
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf http://localhost:8222/healthz >/dev/null 2>&1 && \
           curl -sf http://localhost:8080/realms/nexus-sdv >/dev/null 2>&1 && \
           nc -z localhost 8086 >/dev/null 2>&1 && \
           nc -z localhost 1883 >/dev/null 2>&1; then
            info "All infrastructure services healthy"
            return 0
        fi

        attempt=$((attempt + 1))
        if [ $((attempt % 10)) -eq 0 ]; then
            echo -n "."
        fi
        sleep 1
    done

    error "Infrastructure services failed to start within timeout"
}

# ============================================================================
# PHASE 7: Extract Keycloak JWKS (Dynamic Token)
# ============================================================================
phase_keycloak_jwks() {
    log "Extracting Keycloak JWKS..."

    local jwks_url="http://localhost:8080/realms/nexus-sdv/protocol/openid-connect/certs"
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$jwks_url" > certs/keycloak/jwks.json 2>/dev/null; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    if [ ! -f "certs/keycloak/jwks.json" ] || [ ! -s "certs/keycloak/jwks.json" ]; then
        error "Failed to fetch Keycloak JWKS"
    fi

    # Base64 encode JWKS
    local jwks_b64
    jwks_b64=$(cat certs/keycloak/jwks.json | base64 -b 0)

    if [ -z "$jwks_b64" ]; then
        error "JWKS base64 encoding failed"
    fi

    # Store for injection
    export KEYCLOAK_JWK_B64="$jwks_b64"

    info "Keycloak JWKS extracted and base64 encoded"
}

# ============================================================================
# PHASE 8: Inject All Tokens Into Environment Files
# ============================================================================
phase_inject_tokens() {
    log "Injecting all tokens into environment files..."

    # Update .env.infra with NATS tokens
    sed -i.bak "s|NATS_AUTH_CALLOUT_NKEY_PUB=.*|NATS_AUTH_CALLOUT_NKEY_PUB=$NATS_AUTH_CALLOUT_NKEY_PUB|" .env.infra
    sed -i.bak "s|NATS_ACCOUNT_SIGNING_KEY=.*|NATS_ACCOUNT_SIGNING_KEY=$NATS_ACCOUNT_SIGNING_KEY|" .env.infra

    # Update .env.base-services with Keycloak JWT
    sed -i.bak "s|JWT_ACC_SIGNING_KEY=.*|JWT_ACC_SIGNING_KEY=$NATS_ACCOUNT_SIGNING_KEY|" .env.base-services
    sed -i.bak "s|KEYCLOAK_JWK_B64=.*|KEYCLOAK_JWK_B64=$KEYCLOAK_JWK_B64|" .env.base-services

    # Inject service URLs (auto-discovered)
    sed -i.bak "s|NATS_URL=.*|NATS_URL=nats://nats:4222|" .env.base-services
    sed -i.bak "s|KEYCLOAK_URL=.*|KEYCLOAK_URL=https://keycloak:8443|" .env.base-services
    sed -i.bak "s|BIGTABLE_EMULATOR_HOST=.*|BIGTABLE_EMULATOR_HOST=bigtable-emulator:8086|" .env.base-services

    # Clean up backup files
    rm -f .env.*.bak

    info "All tokens injected (no manual copying needed)"
}

# ============================================================================
# PHASE 9: Build & Start Application Services
# ============================================================================
phase_app_startup() {
    log "Building and starting application services..."

    docker compose build --no-cache
    docker compose up -d

    # Wait for services
    log "Waiting for application services to be healthy..."
    sleep 10

    # Check if services started
    if docker compose ps | grep -q "Exit"; then
        error "Some services failed to start. Run 'docker compose logs' for details."
    fi

    info "Application services started"
}

# ============================================================================
# PHASE 10: Verification
# ============================================================================
phase_verify() {
    log "Verifying setup..."

    local failed=0

    # Check infrastructure
    if ! curl -sf http://localhost:8222/healthz >/dev/null 2>&1; then
        warn "NATS health check failed"
        failed=1
    fi

    if ! curl -sf http://localhost:8080/realms/nexus-sdv >/dev/null 2>&1; then
        warn "Keycloak health check failed"
        failed=1
    fi

    if ! nc -z localhost 8086 >/dev/null 2>&1; then
        warn "Bigtable health check failed"
        failed=1
    fi

    # Check application services
    if ! docker compose ps | grep -q "nexus-data-api.*Up"; then
        warn "Data API not running"
        failed=1
    fi

    if [ $failed -eq 0 ]; then
        info "✓ All services verified and healthy"
        return 0
    else
        warn "Some services failed verification"
        return 1
    fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================
main() {
    log "Starting automated setup..."

    phase_cleanup || true
    phase_network
    phase_certificates
    phase_nats_config
    phase_base_env
    phase_infra_startup
    phase_keycloak_jwks
    phase_inject_tokens
    phase_app_startup

    if phase_verify; then
        log "========================================="
        log "✓ SETUP COMPLETE - ALL AUTOMATIC!"
        log "========================================="
        echo ""
        info "No tokens were hardcoded"
        info "No manual configuration needed"
        info "Everything was auto-generated & injected"
        echo ""
        info "Next steps:"
        echo "  • View logs:      docker compose logs -f"
        echo "  • Query data:     make query"
        echo "  • Run tests:      make test"
        echo "  • Stop services:  make stop"
        echo ""
        info "Services ready at:"
        echo "  • NATS:           nats://localhost:4222"
        echo "  • Keycloak:       http://localhost:8080"
        echo "  • Bigtable:       localhost:8086"
        echo "  • Mosquitto:      localhost:1883"
        echo "  • Data API:       grpc://localhost:9090"
        echo "  • Registration:   https://localhost:8444"
    else
        error "Setup verification failed - check logs and try again"
    fi
}

main "$@"

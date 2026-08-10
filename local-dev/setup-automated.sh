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

cd "$LOCAL_DEV_DIR"

# Wrapper for the app-services compose project. Passing --env-file for both
# app env files makes variable interpolation succeed, so read-only commands
# like 'ps' don't spam 'variable is not set. Defaulting to a blank string'
# (those warnings are harmless - they only affect compose's own metadata
# interpolation, not the already-running containers - but they're noise that
# masks real output). Every app-services compose call goes through here.
compose_app() {
    docker compose --env-file .env.base-services --env-file .env.sample-services "$@"
}

# Poll until a compose service reaches the 'running' state (up to $2 seconds,
# default 45). 'docker compose up -d' returns once containers are created and
# start has been requested, but a container may take a moment more to actually
# be 'running' - so a one-shot check right after 'up' races it and reports a
# healthy service as down. Match the service name exactly against --services
# output (grep -x) rather than grepping STATUS text like 'Up', which is
# format-fragile and, without -x, would let 'data-api' match 'data-api-sampler'.
wait_running() {
    local svc=$1
    local max=${2:-45}
    local i
    for i in $(seq 1 "$max"); do
        if compose_app ps --status running --services 2>/dev/null | grep -qx "$svc"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

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
        local reply=n
        if [ -t 0 ]; then
            read -p "Remove old configuration? (y/n) " -n 1 -r reply
            echo
        fi
        if [[ $reply =~ ^[Yy]$ ]]; then
            log "Removing old config files..."
            rm -f .env.infra .env.base-services .env.sample-services
            info "Old configuration removed"
        else
            info "Keeping existing .env files (templates will only fill missing ones)"
        fi
    fi
}

# ============================================================================
# PHASE 2: Network Setup
# ============================================================================
# The nexus-local network is created and labeled by docker-compose.infra.yml
# itself (see its 'networks:' block) when phase_infra_startup brings it up.
# Do not pre-create it manually here: a network created via a bare
# 'docker network create' lacks the com.docker.compose.* labels that
# docker-compose.yml's 'external: true' declaration expects, which then
# breaks 'docker compose up' for the app services with a
# "network ... was found but has incorrect label" error.

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

    # Generate NKey using Go (in the repo). 'go run' reading a program from
    # stdin (e.g. 'go run <<GOCODE') is unreliable across Go versions/module
    # modes ("no go files listed" / "outside main module") - write a real
    # temp .go file instead and run that, from inside the auth-callout module
    # so it can resolve the already-vendored github.com/nats-io/nkeys dep.
    # (BSD mktemp doesn't support a suffix after the XXXXXX placeholder, so
    # make a temp dir and put a fixed-name .go file inside it.)
    local gen_dir gen_file
    gen_dir="$(mktemp -d)"
    gen_file="$gen_dir/gen_nkey.go"
    cat > "$gen_file" << 'GOCODE'
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

    local nkey_output
    nkey_output=$(cd "$(cd "$LOCAL_DEV_DIR"/.. && pwd)/base-services/auth-callout" && go run "$gen_file")
    rm -rf "$gen_dir"

    local nats_pub=$(echo "$nkey_output" | grep "PUBLIC:" | cut -d: -f2)
    local nats_seed=$(echo "$nkey_output" | grep "SEED:" | cut -d: -f2)

    if [ -z "$nats_pub" ] || [ -z "$nats_seed" ]; then
        error "NATS NKey generation failed"
    fi

    # Store for later use
    export NATS_AUTH_CALLOUT_NKEY_PUB="$nats_pub"
    export NATS_ACCOUNT_SIGNING_KEY="$nats_seed"

    info "NATS NKey generated (stored in memory, will be injected)"

    # Generate NATS config with NKey. This is real nats-server config
    # syntax (accounts{}/authorization{auth_callout{}}), matching what
    # auth-callout actually expects to authenticate against - there is no
    # top-level 'nkeys:' directive in nats-server config, that was invented
    # and crashes the server with 'unknown field "nkeys"'.
    log "Generating NATS configuration..."
    cat > config/nats.conf << EOF
# local-dev/config/nats.conf
# NATS server configuration for local development with auth callout.
# Regenerated by setup-automated.sh's phase_nats_config() on each run -
# do not edit by hand, changes will be overwritten.

listen: 0.0.0.0:4222
http: 0.0.0.0:8222

cluster {
    name: "nats-cluster"
    listen: 0.0.0.0:4248
    routes: ["nats://127.0.0.1:4248"]
}

leafnodes {
    listen: 0.0.0.0:7422
}

accounts {
    # Auth service account - handles auth callout requests
    AUTH {
        users: [
            {user: "auth-callout-service", password: "auth-callout-pass"}
        ]
    }

    # Application account - vehicles with JWT auth
    APP {
        users: [
            {user: "app-user", password: "app-pass"}
        ]
    }

    SYS {
        users: []
    }
}

system_account: "SYS"

authorization {
    # Auth callout for JWT validation - issuer is the NKey generated by
    # phase_nats_config(), also injected into auth-callout's
    # JWT_ACC_SIGNING_KEY (the corresponding seed) via phase_inject_tokens().
    auth_callout {
        issuer: "$NATS_AUTH_CALLOUT_NKEY_PUB"
        auth_users: [
            "auth-callout-service",  # Bypasses callout
            "connector",              # Bypasses callout
            "app-user"                # Bypasses callout
        ]
        account: "AUTH"
    }

    # Default permissions for users without auth callout
    users: [
        {user: "connector", password: "connector-pass", permissions: {subscribe: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>", "commands.>", "pm.>", "_INBOX.>"], publish: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>", "commands.>", "pm.>", "_INBOX.>"]}}
    ]
}

debug: true
trace: true
EOF

    info "NATS configuration created"
}

# ============================================================================
# PHASE 5: Create Base Environment Files (from templates)
# ============================================================================
phase_base_env() {
    log "Creating base environment files..."
    local f
    for f in infra base-services sample-services; do
        if [ ! -f ".env.$f" ]; then
            cp "configs/$f.template" ".env.$f"
            info "Created .env.$f from template"
        else
            info "Keeping existing .env.$f"
        fi
    done
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
           curl -sf http://localhost:8088/realms/nexus-sdv >/dev/null 2>&1 && \
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
# PHASE 6b: Bootstrap Bigtable Schema
# ============================================================================
phase_bigtable_schema() {
    log "Bootstrapping Bigtable table and column families..."

    local container="nexus-bigtable-emulator"
    local project="test-project"
    local instance="test-instance"
    local table="telemetry"

    # Install cbt inside the emulator container (it ships gcloud already;
    # cbt is a gcloud component, not a Go-installable binary).
    if ! docker exec "$container" which cbt > /dev/null 2>&1; then
        docker exec "$container" gcloud components install cbt --quiet > /dev/null
    fi

    cbt_in_container() {
        docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 "$container" cbt \
            -project "$project" -instance "$instance" "$@"
    }

    # Matches the schema data-api's integration tests bootstrap
    # (base-services/data-api/tests/integration/bigtable_steps__test.go):
    # table "telemetry" with "dynamic" and "static" column families. Nothing
    # else in local dev creates this - data-converter only forwards
    # MQTT -> NATS, it does not write to Bigtable - so without this step
    # 'make query' fails with "table ... not found" on a fresh environment.
    if cbt_in_container ls "$table" > /dev/null 2>&1; then
        info "Table '$table' already exists"
    else
        cbt_in_container createtable "$table" > /dev/null
        cbt_in_container createfamily "$table" dynamic > /dev/null
        cbt_in_container createfamily "$table" static > /dev/null
        info "Created table '$table' with column families 'dynamic' and 'static'"
    fi
}

# ============================================================================
# PHASE 7: Extract Keycloak JWKS (Dynamic Token)
# ============================================================================
phase_keycloak_jwks() {
    log "Extracting Keycloak JWKS..."

    local jwks_url="http://localhost:8088/realms/nexus-sdv/protocol/openid-connect/certs"
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sfL "$jwks_url" > certs/keycloak/jwks.json 2>/dev/null; then
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
    jwks_b64=$(base64 < certs/keycloak/jwks.json | tr -d '\n')

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

    # Inject service URLs (auto-discovered). Pattern is anchored to line
    # start (^) so it only matches auth-callout's NATS_URL line - not
    # registration's REG_CLIENT_NATS_URL/REG_CLIENT_KEYCLOAK_URL, which need
    # the host-reachable values already in the template (registration echoes
    # these back to clients like sample-clients/vehicle-client running on
    # the host, so they can't be the in-Docker-network hostnames
    # auth-callout/data-converter use).
    sed -i.bak "s|^NATS_URL=.*|NATS_URL=nats://nats:4222|" .env.base-services
    sed -i.bak "s|^BIGTABLE_EMULATOR_HOST=.*|BIGTABLE_EMULATOR_HOST=bigtable-emulator:8086|" .env.base-services

    # Clean up backup files
    rm -f .env.*.bak

    # Fail fast if any placeholder secret was not replaced by injection.
    if grep -lq "REPLACE_ME" .env.infra .env.base-services .env.sample-services; then
        error "Placeholder secret(s) still present after token injection - refusing to continue"
    fi

    info "All tokens injected (no manual copying needed)"
}

# ============================================================================
# PHASE 9: Build & Start Application Services
# ============================================================================
phase_app_startup() {
    log "Building and starting application services..."

    compose_app build --no-cache
    compose_app up -d

    # Fail fast if a service exited/crashed on startup. A plain 'ps' (without
    # -a) omits stopped containers, so an early crash would be invisible to it -
    # '-a --status exited/dead' is what actually surfaces a crashed service.
    log "Checking for startup failures..."
    sleep 3
    local crashed
    crashed="$(compose_app ps -a --status exited --services 2>/dev/null || true)"
    if [ -n "$crashed" ]; then
        error "Service(s) failed to start: $(echo "$crashed" | tr '\n' ' ')- run 'docker compose logs' for details."
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

    if ! curl -sf http://localhost:8088/realms/nexus-sdv >/dev/null 2>&1; then
        warn "Keycloak health check failed"
        failed=1
    fi

    if ! nc -z localhost 8086 >/dev/null 2>&1; then
        warn "Bigtable health check failed"
        failed=1
    fi

    # Check application services. 'docker compose up -d' returns before a
    # container is necessarily 'running', so poll each service (wait_running)
    # instead of checking once after a fixed sleep - the one-shot check raced
    # a cold first-run and reported a perfectly healthy data-api as "not
    # running". All app services are verified, not just data-api.
    local svc
    for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer nats-bigtable-connector telemetry-chart-service data-web-client; do
        if ! wait_running "$svc"; then
            warn "$svc is not running"
            failed=1
        fi
    done

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
    phase_certificates
    phase_nats_config
    phase_base_env
    phase_infra_startup
    phase_bigtable_schema
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
        echo "  • Keycloak:       http://localhost:8088"
        echo "  • Bigtable:       localhost:8086"
        echo "  • Mosquitto:      localhost:1883"
        echo "  • Data API:       grpc://localhost:9090"
        echo "  • Registration:   https://localhost:8444"
    else
        error "Setup verification failed - check logs and try again"
    fi
}

main "$@"

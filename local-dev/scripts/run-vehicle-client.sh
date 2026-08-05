#!/bin/bash
# local-dev/scripts/run-vehicle-client.sh
# Runs sample-clients/vehicle-client against the local-dev stack, supplying
# everything it needs that normally comes from a GCP bootstrap env file or
# Secret Manager:
#   - FACTORY_CA_CERT/FACTORY_CA_KEY (env-overridable in generate-factory-cert.sh)
#     pointed at the factory CA local-dev/scripts/generate-certs.sh generates,
#     which is the same one the running registration container trusts
#     (registration's FACTORY_CA_CERT env var, see configs/base-services.template).
#   - REGISTRATION_URL, so the client can reach registration's HTTPS port
#     without a -registration-url flag.
#   - KEYCLOAK_REALM/KEYCLOAK_CLIENT_ID/KEYCLOAK_CLIENT_SECRET, so the client
#     targets local-dev's imported realm/client instead of the GCP defaults
#     hardcoded as fallbacks in main.go (see below).
#   - certificates/REGISTRATION_SERVER_TLS_CERT.pem and
#     certificates/KEYCLOAK_TLS_CRT.pem, which main.go reads unconditionally
#     (even with -pki_strategy=local, where InsecureSkipVerify makes their
#     contents irrelevant to the actual TLS handshake - but a missing file
#     is still a fatal error) - copied from the certs local-dev's registration
#     and keycloak containers actually serve.
#
# Usage:
#   ./run-vehicle-client.sh [--vin <VIN>] [--interval <seconds>] [--message-type <type>]
# All flags are passed through to sample-clients/vehicle-client/run-vehicle-client.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." &>/dev/null && pwd)"
VEHICLE_CLIENT_DIR="$REPO_ROOT/sample-clients/vehicle-client"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[vehicle-client]${NC} $*"; }
info() { echo -e "${BLUE}[info]${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

cd "$SCRIPT_DIR"

# --- Sanity checks ---
if ! docker ps --format '{{.Names}}' | grep -qx "nexus-registration"; then
    error "nexus-registration is not running. Start the stack with 'make go' first."
fi

for cert in registration/factory-ca.crt.pem registration/factory-ca.key.pem registration/server.crt.pem keycloak/server.crt.pem; do
    if [ ! -f "certs/$cert" ]; then
        error "certs/$cert not found. Run 'make go' (or 'make setup-auto') first to generate local certificates."
    fi
done

for tool in protoc go; do
    command -v "$tool" >/dev/null 2>&1 || error "'$tool' not found on PATH - required to build vehicle-client (see sample-clients/vehicle-client/README.md prerequisites)."
done

# make build (run by sample-clients/vehicle-client/run-vehicle-client.sh) needs
# protoc-gen-go/protoc-gen-go-grpc, which 'go install' places in $GOPATH/bin -
# not necessarily on PATH already.
export PATH="$PATH:$(go env GOPATH)/bin"

# --- Point the shared cert-generation script at local-dev's factory CA ---
export FACTORY_CA_CERT="$SCRIPT_DIR/certs/registration/factory-ca.crt.pem"
export FACTORY_CA_KEY="$SCRIPT_DIR/certs/registration/factory-ca.key.pem"

# --- URLs: match local-dev's actual host ports (see local-dev/README.md).
# registration's HTTPS is remapped to 8444 (8443 is Keycloak's); Keycloak's
# JWT endpoint used by the client is plain HTTP on 8080, matching
# REG_CLIENT_KEYCLOAK_URL in configs/base-services.template - registration's
# own response echoes this same value back to the client on first
# registration, so it needs to already match here for the reuse-existing-
# certs path too. NATS_URL likewise matches REG_CLIENT_NATS_URL. ---
export REGISTRATION_URL="${REGISTRATION_URL:-https://localhost:8444}"
export KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
export NATS_URL="${NATS_URL:-nats://localhost:4222}"

# --- Force local PKI strategy ---
# run-vehicle-client.sh reads PKI_STRATEGY from iac/bootstrapping/.bootstrap_env
# (a GCP-bootstrap artifact that doesn't exist here) and falls back to
# "remote" if that file/var is missing, which would also ignore the URL
# overrides above (their fallback branch multiplies HOSTNAME by BASE_DOMAIN
# instead of using them directly - see run-vehicle-client.sh's URL-derivation
# comment). Exporting it here selects the local branch for local-dev.
export PKI_STRATEGY="local"

# --- Keycloak identity for local-dev ---
# main.go defaults to the GCP realm ("sdv-telemetry") and client ("car", mTLS,
# no secret). local-dev's imported realm (keycloak/nexus-realm.json) is
# "nexus-sdv" with per-VIN confidential service-account clients (defaulting to
# "VIN123" below), so override the three env vars main.go reads (envOr
# KEYCLOAK_REALM / KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET). The secret
# is read straight out of the realm import at runtime via jq - never hardcoded
# in this script. Per-VIN clients (e.g. VIN123) make azp equal the VIN, which
# is what auth-callout grants NATS permissions on.
export KEYCLOAK_REALM="${KEYCLOAK_REALM:-nexus-sdv}"
export KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-VIN123}"
if [ -z "${KEYCLOAK_CLIENT_SECRET:-}" ]; then
    command -v jq >/dev/null 2>&1 || error "'jq' not found on PATH - needed to read the Keycloak client secret from keycloak/nexus-realm.json (or export KEYCLOAK_CLIENT_SECRET yourself)."
    KEYCLOAK_CLIENT_SECRET="$(jq -r --arg id "$KEYCLOAK_CLIENT_ID" '.clients[] | select(.clientId==$id) | .secret // empty' "$SCRIPT_DIR/keycloak/nexus-realm.json")"
    [ -n "$KEYCLOAK_CLIENT_SECRET" ] || error "Could not read a secret for client '$KEYCLOAK_CLIENT_ID' from keycloak/nexus-realm.json."
    export KEYCLOAK_CLIENT_SECRET
fi

log "Using factory CA: $FACTORY_CA_CERT"
log "Registration URL: $REGISTRATION_URL"
log "Keycloak URL:     $KEYCLOAK_URL"
log "NATS URL:         $NATS_URL"
log "PKI strategy:     $PKI_STRATEGY"
log "Keycloak realm:   $KEYCLOAK_REALM (client: $KEYCLOAK_CLIENT_ID)"

# --- Stage the TLS cert files main.go reads unconditionally ---
mkdir -p "$VEHICLE_CLIENT_DIR/certificates"
cp "$SCRIPT_DIR/certs/registration/server.crt.pem" "$VEHICLE_CLIENT_DIR/certificates/REGISTRATION_SERVER_TLS_CERT.pem"
cp "$SCRIPT_DIR/certs/keycloak/server.crt.pem" "$VEHICLE_CLIENT_DIR/certificates/KEYCLOAK_TLS_CRT.pem"
info "Staged certificates/REGISTRATION_SERVER_TLS_CERT.pem and certificates/KEYCLOAK_TLS_CRT.pem"

# --- Force a rebuild from current source ---
# The inner run-vehicle-client.sh only builds when the binary is missing, so a
# stale binary would silently run old code (e.g. from before the KEYCLOAK_*
# env-gating was added to main.go) and ignore the env overrides above. Removing
# it makes every run rebuild, so source edits always take effect.
rm -f "$VEHICLE_CLIENT_DIR/vehicle-client"

# --- Run ---
log "Launching vehicle-client (pki_strategy=local)..."
cd "$VEHICLE_CLIENT_DIR"
exec ./run-vehicle-client.sh "$@"

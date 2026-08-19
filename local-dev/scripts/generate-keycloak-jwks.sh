#!/bin/bash
set -euo pipefail

# local-dev/scripts/generate-keycloak-jwks.sh
# Extracts JWKS from Keycloak and base64 encodes it for auth-callout

SCRIPTS_DIR="$(dirname "$0")"
CERTS_DIR="$SCRIPTS_DIR/../certs"
KEYCLOAK_URL="${KEYCLOAK_URL:-https://localhost:8443}"
REALM="${REALM:-nexus-sdv}"

log() { echo -e "\033[0;32m[generate-keycloak-jwks]\033[0m $*"; }

log "Waiting for Keycloak to be ready at $KEYCLOAK_URL..."
for i in {1..30}; do
    if curl -k -s -f "$KEYCLOAK_URL/health/ready" > /dev/null 2>&1; then
        log "Keycloak is ready"
        break
    fi
    sleep 2
    if [[ $i -eq 30 ]]; then
        echo "ERROR: Keycloak not ready after 60 seconds" >&2
        exit 1
    fi
done

log "Fetching JWKS from Keycloak realm: $REALM"
JWKS_URL="$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/certs"
curl -k -s "$JWKS_URL" > "$CERTS_DIR/keycloak/jwks.json"

if [[ ! -s "$CERTS_DIR/keycloak/jwks.json" ]]; then
    echo "ERROR: Failed to fetch JWKS" >&2
    exit 1
fi

log "JWKS saved to $CERTS_DIR/keycloak/jwks.json"

# Base64 encode for auth-callout
KEYCLOAK_JWK_B64=$(base64 -w0 "$CERTS_DIR/keycloak/jwks.json")
log "KEYCLOAK_JWK_B64 generated (${#KEYCLOAK_JWK_B64} chars)"

# Output to stdout for capturing
echo "$KEYCLOAK_JWK_B64"

# Also append to .env.local
echo "KEYCLOAK_JWK_B64=$KEYCLOAK_JWK_B64" >> "$SCRIPTS_DIR/../.env.local"
log "KEYCLOAK_JWK_B64 appended to .env.local"
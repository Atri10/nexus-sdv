#!/bin/sh
# Local-dev simulator entrypoint: mint a factory cert for the chosen VIN,
# stage the TLS certs the client reads unconditionally, then run in control
# mode. VIN_POOL is space/comma-separated; the binary picks a random member
# when -vin is empty. The chosen VIN is persisted to certificates/vin so
# restarts reuse the same identity (the client reuses its operational cert
# and JWT, which are only valid for the VIN that minted them).
set -eu

CERTS_DIR=/certs
WORK_DIR=/app
mkdir -p "$WORK_DIR/certificates"

# Stage server TLS certs the client reads unconditionally (PKI_STRATEGY=local
# ignores their contents for verification, but missing files are fatal).
cp "$CERTS_DIR/registration/server.crt.pem" "$WORK_DIR/certificates/REGISTRATION_SERVER_TLS_CERT.pem"
cp "$CERTS_DIR/keycloak/server.crt.pem"     "$WORK_DIR/certificates/KEYCLOAK_TLS_CRT.pem"

# Pick VIN (binary randomizes when VIN is empty) and mint a factory cert.
VIN="${VIN:-}"
if [ -z "$VIN" ]; then
    if [ -f "$WORK_DIR/certificates/operational-cert.pem" ]; then
        # Existing operational cert + JWT are tied to the VIN that minted
        # them; reuse that VIN instead of re-randomizing.
        VIN="$(cat "$WORK_DIR/certificates/vin" 2>/dev/null || true)"
        [ -n "$VIN" ] || VIN="VIN1001"
    else
        VIN=$(printf '%s\n' "$VIN_POOL" | tr ',' ' ' | tr -s ' ' '\n' | sed '/^$/d' | shuf -n 1)
        [ -n "$VIN" ] || VIN="VIN1001"
    fi
fi
# Persist the chosen VIN so restarts reuse the same identity.
printf '%s\n' "$VIN" > "$WORK_DIR/certificates/vin"

FACTORY_PREFIX="$WORK_DIR/certificates/factory-$VIN"
openssl req -newkey rsa:2048 -nodes \
    -keyout "$FACTORY_PREFIX-key.pem" \
    -out /tmp/factory.csr \
    -subj "/CN=VIN:$VIN DEVICE:simulator"
cat > "$FACTORY_PREFIX.ext" <<'EOF'
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in /tmp/factory.csr \
    -CA "$CERTS_DIR/registration/factory-ca.crt.pem" \
    -CAkey "$CERTS_DIR/registration/factory-ca.key.pem" \
    -CAserial "$FACTORY_PREFIX.srl" \
    -CAcreateserial \
    -out "$FACTORY_PREFIX-chain.pem" -days 365 -sha256 \
    -extfile "$FACTORY_PREFIX.ext"
rm -f /tmp/factory.csr

echo "Simulator: VIN=$VIN (control subject commands.$VIN.demo)"

export KEYCLOAK_CLIENT_ID="$VIN"
export KEYCLOAK_CLIENT_SECRET="$(echo "$VIN" | tr '[:upper:]' '[:lower:]')-secret"

exec /vehicle-client \
    -vin="$VIN" \
    -pki_strategy=local \
    -factory-cert="$FACTORY_PREFIX-chain.pem" \
    -factory-key="$FACTORY_PREFIX-key.pem" \
    -registration-url="${REGISTRATION_URL:-https://registration:8443}" \
    -keycloak-url="${KEYCLOAK_URL:-http://keycloak:8080}" \
    -nats-url="${NATS_URL:-nats://nats:4222}" \
    -message-type=both \
    -control-subject="commands.$VIN.demo" \
    -interval="${INTERVAL:-2}"

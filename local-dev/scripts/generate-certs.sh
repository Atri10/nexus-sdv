#!/bin/bash
set -euo pipefail

# local-dev/scripts/generate-certs.sh
# Generates self-signed CA and certificates for all local services

CERTS_DIR="$(dirname "$0")/../certs"
SCRIPTS_DIR="$(dirname "$0")"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[generate-certs]${NC} $*"; }
warn() { echo -e "${YELLOW}[generate-certs]${NC} $*"; }

mkdir -p "$CERTS_DIR"/{ca,registration,nats,keycloak,clients}

# Check if already generated
if [[ -f "$CERTS_DIR/ca/ca.crt.pem" ]]; then
    log "Certificates already exist, skipping generation"
    exit 0
fi

log "Generating Root CA..."
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$CERTS_DIR/ca/ca.key.pem" \
    -out "$CERTS_DIR/ca/ca.crt.pem" \
    -subj "/CN=Nexus Local Root CA/O=Nexus SDV" \
    -addext "basicConstraints=critical,CA:true"

log "Generating NATS Server Certificate..."
cat > /tmp/nats.conf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = nats.local

[v3_req]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth

[alt_names]
DNS.1 = localhost
DNS.2 = nats
DNS.3 = nats.base-services.svc.cluster.local
IP.1 = 127.0.0.1
EOF

openssl req -newkey rsa:2048 -nodes -keyout "$CERTS_DIR/nats/server.key.pem" \
    -out /tmp/nats.csr -config /tmp/nats.conf
openssl x509 -req -in /tmp/nats.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/nats/server.crt.pem" -days 365 -sha256 \
    -extfile /tmp/nats.conf -extensions v3_req

# NATS CA (same as root for simplicity, but could be separate)
cp "$CERTS_DIR/ca/ca.crt.pem" "$CERTS_DIR/nats/ca.crt.pem"

log "Generating Registration Server Certificate..."
cat > /tmp/reg.conf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = registration.local

[v3_req]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth

[alt_names]
DNS.1 = localhost
DNS.2 = registration
DNS.3 = registration.base-services.svc.cluster.local
IP.1 = 127.0.0.1
EOF

openssl req -newkey rsa:2048 -nodes -keyout "$CERTS_DIR/registration/server.key.pem" \
    -out /tmp/reg.csr -config /tmp/reg.conf
openssl x509 -req -in /tmp/reg.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/registration/server.crt.pem" -days 365 -sha256 \
    -extfile /tmp/reg.conf -extensions v3_req

log "Generating Registration CA (for signing vehicle CSRs)..."
openssl req -newkey rsa:4096 -nodes -keyout "$CERTS_DIR/registration/ca.key.pem" \
    -out /tmp/reg-ca.csr -subj "/CN=Nexus Registration CA/O=Nexus SDV"
openssl x509 -req -in /tmp/reg-ca.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/registration/ca.crt.pem" -days 3650 -sha256 \
    -extensions v3_ca -extfile <(echo -e "[v3_ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign")

log "Generating Factory CA (for validating factory-issued certs)..."
openssl req -newkey rsa:4096 -nodes -keyout "$CERTS_DIR/registration/factory-ca.key.pem" \
    -out /tmp/factory-ca.csr -subj "/CN=Nexus Factory CA/O=Nexus Factory"
openssl x509 -req -in /tmp/factory-ca.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/registration/factory-ca.crt.pem" -days 3650 -sha256 \
    -extensions v3_ca -extfile <(echo -e "[v3_ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nextendedKeyUsage=clientAuth")

log "Generating Keycloak Certificate..."
cat > /tmp/kc.conf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = keycloak.local

[v3_req]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
DNS.2 = keycloak
DNS.3 = keycloak.local
IP.1 = 127.0.0.1
EOF

openssl req -newkey rsa:2048 -nodes -keyout "$CERTS_DIR/keycloak/server.key.pem" \
    -out /tmp/kc.csr -config /tmp/kc.conf
openssl x509 -req -in /tmp/kc.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/keycloak/server.crt.pem" -days 365 -sha256 \
    -extfile /tmp/kc.conf -extensions v3_req

log "Generating Test Device Certificate (VIN:VIN123 DEVICE:DEV456)..."
DEVICE_CN="VIN:VIN123 DEVICE:DEV456"
openssl req -newkey rsa:2048 -nodes -keyout "$CERTS_DIR/clients/device-vin123-dev456.key.pem" \
    -out /tmp/device.csr -subj "/CN=$DEVICE_CN"
openssl x509 -req -in /tmp/device.csr -CA "$CERTS_DIR/registration/ca.crt.pem" \
    -CAkey "$CERTS_DIR/registration/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/clients/device-vin123-dev456.crt.pem" -days 365 -sha256

log "Cleaning up temporary files..."
rm -f /tmp/*.csr /tmp/*.conf /tmp/*.srl

log "Certificate generation complete!"
log "Certificates written to: $CERTS_DIR"
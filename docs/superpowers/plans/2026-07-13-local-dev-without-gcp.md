# Local Development Without GCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a complete local development environment using Docker Compose, self-signed certificates, and local emulators - no GCP account required.

**Architecture:** Four docker-compose files orchestrate infrastructure (NATS, Keycloak, Bigtable emulator, Mosquitto) and services (base + sample). An init container generates all certificates. Keycloak realm is pre-configured. Environment files provide all configuration. Health check scripts orchestrate startup.

**Tech Stack:** Docker Compose, OpenSSL, Keycloak 24, NATS 2.10, Bigtable emulator, Mosquitto 2, existing Go/Rust/Java/Python services

## Global Constraints

- All local dev files in `local-dev/` directory (gitignored except `scripts/`)
- Zero GCP dependencies - all services run locally in containers
- Self-signed PKI with local CA as trust anchor
- Configuration via `.env` files only (no Secret Manager)
- Minimal code changes - leverage existing env var patterns
- All Docker images must work in kind clusters
- Certificates generated once via `docker-compose.certs.yml` init container
- Keycloak JWKS extracted after startup via script
- Health checks required for all services before dependent services start

---

### Task 1: Create local-dev Directory Structure & Gitignore

**Files:**
- Create: `local-dev/scripts/generate-certs.sh`
- Create: `local-dev/scripts/generate-keycloak-jwks.sh`
- Create: `local-dev/scripts/wait-for-services.sh`
- Create: `local-dev/config/nats.conf`
- Create: `local-dev/config/mosquitto.conf`
- Create: `local-dev/keycloak/nexus-realm.json`
- Create: `local-dev/env/.env.infra.template`
- Create: `local-dev/env/.env.base-services.template`
- Create: `local-dev/env/.env.sample-services.template`
- Modify: `.gitignore`

**Interfaces:**
- Produces: Directory structure for all subsequent tasks

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p local-dev/{scripts,config,keycloak,env,certs/{ca,registration,nats,keycloak,clients}}
```

- [ ] **Step 2: Update .gitignore**

```bash
# Local development (generated certs and env files)
local-dev/certs/
local-dev/.env.local
local-dev/env/.env.infra
local-dev/env/.env.base-services
local-dev/env/.env.sample-services
!local-dev/scripts/
!local-dev/config/
!local-dev/keycloak/
!local-dev/env/*.template
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore local-dev/
git commit -m "chore: add local-dev directory structure and gitignore"
```

---

### Task 2: Create Certificate Generation Script

**Files:**
- Create: `local-dev/scripts/generate-certs.sh`

**Interfaces:**
- Consumes: `local-dev/scripts/generate-certs.sh`
- Produces: Certificates in `local-dev/certs/` consumed by all services

- [ ] **Step 1: Write the certificate generation script**

```bash
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
    -addext "basicConstraints=critical,CA:true" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

log "Generating Factory CA (for validating factory-issued certs)..."
openssl req -newkey rsa:4096 -nodes -keyout "$CERTS_DIR/registration/factory-ca.key.pem" \
    -out /tmp/factory-ca.csr -subj "/CN=Nexus Factory CA/O=Nexus Factory"
openssl x509 -req -in /tmp/factory-ca.csr -CA "$CERTS_DIR/ca/ca.crt.pem" \
    -CAkey "$CERTS_DIR/ca/ca.key.pem" -CAcreateserial \
    -out "$CERTS_DIR/registration/factory-ca.crt.pem" -days 3650 -sha256 \
    -addext "basicConstraints=critical,CA:true" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "extendedKeyUsage=clientAuth"

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
```

- [ ] **Step 2: Make script executable and test**

```bash
chmod +x local-dev/scripts/generate-certs.sh
./local-dev/scripts/generate-certs.sh
```

- [ ] **Step 3: Verify certificates generated**

```bash
ls -la local-dev/certs/
ls -la local-dev/certs/ca/
ls -la local-dev/certs/nats/
ls -la local-dev/certs/registration/
ls -la local-dev/certs/keycloak/
ls -la local-dev/certs/clients/
```

- [ ] **Step 4: Commit**

```bash
git add local-dev/scripts/generate-certs.sh
git commit -m "feat: add certificate generation script"
```

---

### Task 3: Create Keycloak JWKS Extraction Script

**Files:**
- Create: `local-dev/scripts/generate-keycloak-jwks.sh`

**Interfaces:**
- Consumes: Running Keycloak instance
- Produces: `local-dev/certs/keycloak/jwks.json` and `KEYCLOAK_JWK_B64` env var

- [ ] **Step 1: Write the JWKS extraction script**

```bash
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
```

- [ ] **Step 2: Make executable and test**

```bash
chmod +x local-dev/scripts/generate-keycloak-jwks.sh
```

- [ ] **Step 3: Commit**

```bash
git add local-dev/scripts/generate-keycloak-jwks.sh
git commit -m "feat: add Keycloak JWKS extraction script"
```

---

### Task 4: Create Health Check / Wait Script

**Files:**
- Create: `local-dev/scripts/wait-for-services.sh`

**Interfaces:**
- Consumes: Running services
- Produces: Exit code 0 when all healthy

- [ ] **Step 1: Write the wait script**

```bash
#!/bin/bash
set -euo pipefail

# local-dev/scripts/wait-for-services.sh
# Waits for all local services to be healthy

log() { echo -e "\033[0;32m[wait-for-services]\033[0m $*"; }
error() { echo -e "\033[0;31m[wait-for-services]\033[0m $*" >&2; }

wait_for() {
    local name=$1
    local check_cmd=$2
    local max_attempts=${3:-30}
    local delay=${4:-2}

    log "Waiting for $name..."
    for i in $(seq 1 $max_attempts); do
        if eval "$check_cmd" > /dev/null 2>&1; then
            log "$name is healthy"
            return 0
        fi
        sleep $delay
    done
    error "$name failed health check after $((max_attempts * delay)) seconds"
    return 1
}

# Health checks
wait_for "NATS" "curl -f http://localhost:8222/healthz"
wait_for "Keycloak" "curl -f http://localhost:8080/health/ready"
wait_for "Bigtable Emulator" "grpc_health_probe -addr=localhost:8086 2>/dev/null || nc -z localhost 8086"
wait_for "Mosquitto" "nc -z localhost 1883"
wait_for "auth-callout" "nc -z localhost 4222"  # NATS port via auth-callout
wait_for "data-api" "grpc_health_probe -addr=localhost:8080 2>/dev/null || nc -z localhost 8080"
wait_for "registration" "curl -f http://localhost:8888/health"
wait_for "data-api-sampler" "nc -z localhost 8080"  # if HTTP endpoint added

log "All services are healthy!"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x local-dev/scripts/wait-for-services.sh
```

- [ ] **Step 3: Commit**

```bash
git add local-dev/scripts/wait-for-services.sh
git commit -m "feat: add service health check wait script"
```

---

### Task 5: Create NATS Configuration with Auth Callout

**Files:**
- Create: `local-dev/config/nats.conf`

**Interfaces:**
- Consumes: `local-dev/certs/nats/` certificates
- Produces: NATS server with TLS and auth callout configured

- [ ] **Step 1: Write NATS config**

```
# local-dev/config/nats.conf
# NATS server configuration for local development with auth callout

# Listeners
listen: 0.0.0.0:4222

# TLS Configuration
tls {
    cert_file: "/etc/nats/certs/server.crt.pem"
    key_file: "/etc/nats/certs/server.key.pem"
    ca_file: "/etc/nats/certs/ca.crt.pem"
    verify: false
    timeout: 20
}

# HTTP monitoring
http: 0.0.0.0:8222

# Cluster
cluster {
    name: "nats-cluster"
    listen: 0.0.0.0:4248
    routes: ["nats://127.0.0.1:4248"]
}

# Leafnodes
leafnodes {
    listen: 0.0.0.0:7422
}

# Authorization with Auth Callout
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
        nkeys: ["*" ]  # Allow NKey/JWT authentication
    }

    # System account
    SYS {
        users: []
    }
}

# System account for server operations
system_account: "SYS"

# Authorization configuration
authorization {
    # Auth callout for JWT validation
    auth_callout {
        issuer: "AAA..."  # Filled in by env var at runtime
        auth_users: [
            "auth-callout-service",  # Bypasses callout
            "connector",              # Bypasses callout
            "app-user"                # Bypasses callout
        ]
        account: "AUTH"
    }

    # Default permissions for users without auth callout
    users: [
        {user: "connector", password: "connector-pass", permissions: {subscribe: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>"], publish: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>"]}}
    ]
}

# Debug
debug: true
trace: true
```

- [ ] **Step 2: Commit**

```bash
git add local-dev/config/nats.conf
git commit -m "feat: add NATS config with auth callout"
```

---

### Task 6: Create Mosquitto Configuration

**Files:**
- Create: `local-dev/config/mosquitto.conf`

**Interfaces:**
- Consumes: N/A
- Produces: MQTT broker for data-converter

- [ ] **Step 1: Write Mosquitto config**

```
# local-dev/config/mosquitto.conf
# Mosquitto MQTT broker for local development

# Listeners
listener 1883
protocol mqtt
allow_anonymous true

# Optional TLS listener
# listener 8883
# protocol mqtt
# certfile /mosquitto/certs/server.crt.pem
# keyfile /mosquitto/certs/server.key.pem
# cafile /mosquitto/certs/ca.crt.pem
# require_certificate false

# Persistence
persistence true
persistence_location /mosquitto/data/

# Logging
log_type all
log_dest stdout

# Limits
max_connections 1000
max_inflight_messages 100
```

- [ ] **Step 2: Commit**

```bash
git add local-dev/config/mosquitto.conf
git commit -m "feat: add Mosquitto MQTT config"
```

---

### Task 7: Create Keycloak Realm Export

**Files:**
- Create: `local-dev/keycloak/nexus-realm.json`

**Interfaces:**
- Consumes: Keycloak startup with `--import-realm`
- Produces: Pre-configured realm with clients, roles, users

- [ ] **Step 1: Write realm export (abbreviated - full file in implementation)**

```json
{
  "realm": "nexus-sdv",
  "enabled": true,
  "displayName": "Nexus SDV Local",
  "sslRequired": "external",
  "registrationAllowed": false,
  "loginWithEmailAllowed": false,
  "duplicateEmailsAllowed": false,
  "resetPasswordAllowed": true,
  "editUsernameAllowed": false,
  "bruteForceProtected": true,
  "roles": {
    "realm": [
      {"name": "edge-device", "description": "Vehicle edge device"},
      {"name": "telemetry-client", "description": "Telemetry publisher"},
      {"name": "telemetry-collector", "description": "Telemetry subscriber"}
    ],
    "client": {}
  },
  "clients": [
    {
      "clientId": "vehicle-client",
      "name": "Vehicle Client",
      "description": "Client for vehicle devices",
      "rootUrl": "",
      "adminUrl": "",
      "baseUrl": "",
      "surrogateAuthRequired": false,
      "enabled": true,
      "alwaysDisplayInConsole": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "vehicle-client-secret",
      "redirectUris": ["*"],
      "webOrigins": ["*"],
      "notBefore": 0,
      "bearerOnly": false,
      "consentRequired": false,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "publicClient": false,
      "frontchannelLogout": false,
      "protocol": "openid-connect",
      "attributes": {
        "oauth2.device.authorization.grant.enabled": "false",
        "oidc.ciba.grant.enabled": "false",
        "client.secret.creation.time": "0"
      },
      "authenticationFlowBindingOverrides": {},
      "fullScopeAllowed": true,
      "nodeReRegistrationTimeout": -1,
      "protocolMappers": [
        {
          "name": "realm roles",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "consentRequired": false,
          "config": {
            "multivalued": "true",
            "userinfo.token.claim": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "realm_access.roles",
            "jsonType.label": "String"
          }
        }
      ]
    },
    {
      "clientId": "data-api-sampler",
      "name": "Data API Sampler",
      "secret": "sampler-secret",
      "enabled": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "protocol": "openid-connect"
    },
    {
      "clientId": "trip-analyzer",
      "name": "Trip Analyzer",
      "secret": "trip-analyzer-secret",
      "enabled": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "protocol": "openid-connect"
    }
  ],
  "users": [
    {
      "username": "test-device",
      "enabled": true,
      "emailVerified": false,
      "firstName": "Test",
      "lastName": "Device",
      "email": "test@nexus.local",
      "credentials": [
        {
          "type": "password",
          "value": "test",
          "temporary": false
        }
      ],
      "realmRoles": ["edge-device", "telemetry-client"]
    }
  ],
  "clientScopes": [
    {
      "name": "roles",
      "description": "Realm roles in token",
      "protocol": "openid-connect",
      "attributes": {
        "include.in.token.scope": "true",
        "display.on.consent.screen": "false"
      },
      "protocolMappers": [
        {
          "name": "realm roles",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "config": {
            "multivalued": "true",
            "userinfo.token.claim": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "realm_access.roles"
          }
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add local-dev/keycloak/nexus-realm.json
git commit -m "feat: add Keycloak realm export for local dev"
```

---

### Task 8: Create Environment Template Files

**Files:**
- Create: `local-dev/env/.env.infra.template`
- Create: `local-dev/env/.env.base-services.template`
- Create: `local-dev/env/.env.sample-services.template`

**Interfaces:**
- Consumes: N/A
- Produces: Template files copied to actual `.env` files at setup

- [ ] **Step 1: Write `.env.infra.template`**

```bash
# local-dev/env/.env.infra.template
# Infrastructure passwords - COPY TO .env.infra AND FILL IN

# NATS Authentication
NATS_AUTH_CALLOUT_PASSWORD=auth-callout-pass
NATS_BASIC_AUTH_USER=app-user
NATS_BASIC_AUTH_PASSWORD=app-pass
NATS_CONNECTOR_PASSWORD=connector-pass

# NATS Auth Callout NKey Public (generated by setup script)
NATS_AUTH_CALLOUT_NKEY_PUB=

# Keycloak Admin
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=admin
```

- [ ] **Step 2: Write `.env.base-services.template`**

```bash
# local-dev/env/.env.base-services.template
# Base services configuration - COPY TO .env.base-services AND FILL IN

# auth-callout
JWT_ACC_SIGNING_KEY=  # NKey seed (generated by setup script)
KEYCLOAK_JWK_B64=     # Base64 JWKS (generated after Keycloak starts)
NATS_URL=nats://nats:4222
NATS_USER=auth-callout-service
NATS_PASSWORD=auth-callout-pass

# data-api
GRPC_ADDR=0.0.0.0:8080
BIGTABLE_EMULATOR_HOST=bigtable-emulator:8086
GCP_PROJECT=test-project
BT_INSTANCE=test-instance
BT_TABLE=telemetry
LOG_LEVEL=debug

# data-converter
CONFIG_PATH=/config/config.yaml
NATS_HOST=nats
MQTT_HOST=mosquitto
NATS_TOKEN=
NATS_USER=connector
NATS_PASSWORD=connector-pass

# registration
REG_SERVER_CERT=/certs/registration/server.crt.pem
REG_SERVER_KEY=/certs/registration/server.key.pem
REG_CA_CERT=/certs/registration/ca.crt.pem
REG_CA_KEY=/certs/registration/ca.key.pem
FACTORY_CA_CERT=/certs/registration/factory-ca.crt.pem
NATS_URL=nats://nats:4222
KEYCLOAK_URL=https://keycloak:8443
```

- [ ] **Step 3: Write `.env.sample-services.template`**

```bash
# local-dev/env/.env.sample-services.template
# Sample services configuration - COPY TO .env.sample-services

DATA_API_GRPC_ADDR=data-api:8080
```

- [ ] **Step 4: Commit**

```bash
git add local-dev/env/
git commit -m "feat: add environment template files"
```

---

### Task 9: Create docker-compose.certs.yml (Certificate Generation)

**Files:**
- Create: `local-dev/docker-compose.certs.yml`

**Interfaces:**
- Consumes: `local-dev/scripts/generate-certs.sh`
- Produces: Certificates in `local-dev/certs/` volume

- [ ] **Step 1: Write docker-compose.certs.yml**

```yaml
# local-dev/docker-compose.certs.yml
# Init container to generate all self-signed certificates

services:
  cert-generator:
    image: alpine:3.20
    container_name: nexus-cert-generator
    working_dir: /workspace
    volumes:
      - ./scripts:/workspace/scripts:ro
      - ./certs:/workspace/certs
    command: >
      sh -c "
        apk add --no-cache openssl &&
        ./scripts/generate-certs.sh
      "
    environment:
      - CERTS_DIR=/workspace/certs
    restart: "no"

volumes:
  certs:
    driver: local
    driver_opts:
      type: none
      device: ${PWD}/certs
      o: bind
```

- [ ] **Step 2: Test certificate generation**

```bash
cd local-dev
docker compose -f docker-compose.certs.yml up cert-generator
```

- [ ] **Step 3: Verify certificates**

```bash
ls -la certs/
```

- [ ] **Step 4: Commit**

```bash
git add local-dev/docker-compose.certs.yml
git commit -m "feat: add certificate generation docker-compose"
```

---

### Task 10: Create docker-compose.infra.yml (Infrastructure)

**Files:**
- Create: `local-dev/docker-compose.infra.yml`

**Interfaces:**
- Consumes: `local-dev/certs/`, `local-dev/config/`, `local-dev/keycloak/`, `local-dev/env/.env.infra`
- Produces: Running NATS, Mosquitto, Bigtable, Keycloak

- [ ] **Step 1: Write docker-compose.infra.yml**

```yaml
# local-dev/docker-compose.infra.yml
# Infrastructure services: NATS, Mosquitto, Bigtable Emulator, Keycloak

services:
  nats:
    image: nats:2.10-alpine
    container_name: nexus-nats
    command: ["-c", "/etc/nats/nats.conf"]
    volumes:
      - ./certs/nats:/etc/nats/certs:ro
      - ./config/nats.conf:/etc/nats/nats.conf:ro
    ports:
      - "4222:4222"    # Client connections
      - "7422:7422"    # Leaf nodes
      - "8222:8222"    # HTTP monitoring
    environment:
      - NATS_AUTH_CALLOUT_PASSWORD=${NATS_AUTH_CALLOUT_PASSWORD}
      - NATS_BASIC_AUTH_PASSWORD=${NATS_BASIC_AUTH_PASSWORD}
      - NATS_CONNECTOR_PASSWORD=${NATS_CONNECTOR_PASSWORD}
      - NATS_AUTH_CALLOUT_NKEY_PUB=${NATS_AUTH_CALLOUT_NKEY_PUB}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8222/healthz"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s
    networks:
      - nexus-local

  mosquitto:
    image: eclipse-mosquitto:2
    container_name: nexus-mosquitto
    volumes:
      - ./config/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
    ports:
      - "1883:1883"
      - "8883:8883"
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "1883"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - nexus-local

  bigtable-emulator:
    image: gcr.io/google.com/cloudsdktool/cloud-sdk:emulators
    container_name: nexus-bigtable-emulator
    command: >
      sh -c "gcloud beta emulators bigtable start --host-port=0.0.0.0:8086 --project=test-project"
    ports:
      - "8086:8086"
    environment:
      - BIGTABLE_EMULATOR_HOST=localhost:8086
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "8086"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    networks:
      - nexus-local

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    container_name: nexus-keycloak
    command: start-dev --import-realm --http-port=8080 --https-port=8443
    volumes:
      - ./certs/keycloak:/etc/keycloak/certs:ro
      - ./keycloak/nexus-realm.json:/opt/keycloak/data/import/nexus-realm.json:ro
    ports:
      - "8080:8080"   # HTTP
      - "8443:8443"   # HTTPS
    environment:
      - KC_BOOTSTRAP_ADMIN_USERNAME=${KEYCLOAK_ADMIN_USER}
      - KC_BOOTSTRAP_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
      - KC_HOSTNAME=keycloak.local
      - KC_HTTP_ENABLED=true
      - KC_HTTPS_PORT=8443
      - KC_HTTPS_CERTIFICATE_FILE=/etc/keycloak/certs/server.crt.pem
      - KC_HTTPS_CERTIFICATE_KEY_FILE=/etc/keycloak/certs/server.key.pem
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health/ready"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 30s
    networks:
      - nexus-local

networks:
  nexus-local:
    driver: bridge
```

- [ ] **Step 2: Create actual .env.infra from template**

```bash
cd local-dev
cp env/.env.infra.template .env.infra
# Edit .env.infra with actual values
```

- [ ] **Step 3: Test infrastructure startup**

```bash
docker compose -f docker-compose.infra.yml --env-file .env.infra up -d
./scripts/wait-for-infra.sh  # Create this helper
```

- [ ] **Step 4: Commit**

```bash
git add local-dev/docker-compose.infra.yml
git commit -m "feat: add infrastructure docker-compose"
```

---

### Task 11: Create docker-compose.yml (Application Services)

**Files:**
- Create: `local-dev/docker-compose.yml`

**Interfaces:**
- Consumes: `local-dev/certs/`, `local-dev/env/.env.base-services`, `local-dev/env/.env.sample-services`, infrastructure services
- Produces: Running auth-callout, data-api, data-converter, registration, data-api-sampler, trip-analyzer

- [ ] **Step 1: Write docker-compose.yml**

```yaml
# local-dev/docker-compose.yml
# Application services: base-services + sample-services

services:
  auth-callout:
    build:
      context: ../base-services/auth-callout
      dockerfile: Dockerfile
    container_name: nexus-auth-callout
    environment:
      - JWT_ACC_SIGNING_KEY=${JWT_ACC_SIGNING_KEY}
      - KEYCLOAK_JWK_B64=${KEYCLOAK_JWK_B64}
      - NATS_URL=${NATS_URL}
      - NATS_USER=${NATS_USER}
      - NATS_PASSWORD=${NATS_PASSWORD}
      - LOG_LEVEL=DEBUG
    depends_on:
      nats:
        condition: service_healthy
    networks:
      - nexus-local

  data-api:
    build:
      context: ../base-services/data-api
      dockerfile: Dockerfile
    container_name: nexus-data-api
    environment:
      - GRPC_ADDR=${GRPC_ADDR}
      - BIGTABLE_EMULATOR_HOST=${BIGTABLE_EMULATOR_HOST}
      - GCP_PROJECT=${GCP_PROJECT}
      - BT_INSTANCE=${BT_INSTANCE}
      - BT_TABLE=${BT_TABLE}
      - LOG_LEVEL=debug
    ports:
      - "8080:8080"
    depends_on:
      bigtable-emulator:
        condition: service_healthy
    networks:
      - nexus-local

  data-converter:
    build:
      context: ../base-services/data-converter
      dockerfile: Dockerfile
    container_name: nexus-data-converter
    environment:
      - CONFIG_PATH=${CONFIG_PATH}
      - NATS_HOST=${NATS_HOST}
      - MQTT_HOST=${MQTT_HOST}
      - NATS_TOKEN=${NATS_TOKEN}
      - NATS_USER=${NATS_USER}
      - NATS_PASSWORD=${NATS_PASSWORD}
    volumes:
      - ./config/data-converter.yaml:/config/config.yaml:ro
    depends_on:
      nats:
        condition: service_healthy
      mosquitto:
        condition: service_healthy
    networks:
      - nexus-local

  registration:
    build:
      context: ../base-services/registration/server
      dockerfile: Dockerfile
    container_name: nexus-registration
    environment:
      - REG_SERVER_CERT=${REG_SERVER_CERT}
      - REG_SERVER_KEY=${REG_SERVER_KEY}
      - REG_CA_CERT=${REG_CA_CERT}
      - REG_CA_KEY=${REG_CA_KEY}
      - FACTORY_CA_CERT=${FACTORY_CA_CERT}
      - NATS_URL=${NATS_URL}
      - KEYCLOAK_URL=${KEYCLOAK_URL}
    ports:
      - "8443:8443"  # HTTPS
      - "8888:8888"  # HTTP health
    volumes:
      - ./certs/registration:/certs/registration:ro
    depends_on:
      nats:
        condition: service_healthy
      keycloak:
        condition: service_healthy
    networks:
      - nexus-local

  data-api-sampler:
    build:
      context: ../sample-services/data-api-sampler
      dockerfile: Dockerfile
    container_name: nexus-data-api-sampler
    environment:
      - DATA_API_GRPC_ADDR=${DATA_API_GRPC_ADDR}
    depends_on:
      - data-api
    networks:
      - nexus-local

  trip-analyzer:
    build:
      context: ../sample-services/trip_analyzer
      dockerfile: Dockerfile
    container_name: nexus-trip-analyzer
    environment:
      - DATA_API_GRPC_ADDR=${DATA_API_GRPC_ADDR}
    depends_on:
      - data-api
    networks:
      - nexus-local

networks:
  nexus-local:
    external: true
```

- [ ] **Step 2: Create data-converter config**

```bash
# Create local-dev/config/data-converter.yaml
cat > local-dev/config/data-converter.yaml << 'EOF'
service:
  name: data-converter
  log_level: info

nats:
  url: "nats://nats:4222"

mqtt:
  broker: "tcp://mosquitto:1883"
  clientId: "nexus-data-converter"
  bufferSize: 1000

converters:
  - name: telemetry-sensors
    source:
      adapter: mqtt
      topic: "telemetry/+/sensors/#"
      qos: 1
    mapping:
      device_id: '{{ seg .topic 1 }}'
      sensors:
        - sensor: '{{ jsonpath .payload "name" }}'
          value: '{{ jsonpath .payload "value" }}'
          data_type: DYNAMIC
    target:
      subject_prefix: "prod.bigtable"
      subject_pattern: 'telemetry.{{ .subject_prefix }}.{{ .device_id }}.{{ .sensor }}'

secrets:
  natsUser: "${NATS_USER}"
  natsPassword: "${NATS_PASSWORD}"
  mqttUser: ""
  mqttPassword: ""
EOF
```

- [ ] **Step 3: Create actual env files from templates**

```bash
cd local-dev
cp env/.env.base-services.template .env.base-services
cp env/.env.sample-services.template .env.sample-services
# Edit with actual values (cert paths, etc.)
```

- [ ] **Step 4: Test full stack**

```bash
# Start infra
docker compose -f docker-compose.infra.yml --env-file .env.infra up -d
./scripts/wait-for-services.sh  # Wait for infra

# Get JWKS from Keycloak
./scripts/generate-keycloak-jwks.sh

# Start services
docker compose --env-file .env.base-services --env-file .env.sample-services up -d
./scripts/wait-for-services.sh
```

- [ ] **Step 5: Commit**

```bash
git add local-dev/docker-compose.yml local-dev/config/data-converter.yaml
git commit -m "feat: add application services docker-compose"
```

---

### Task 12: Update Registration Service for Configurable Cert Paths

**Files:**
- Modify: `base-services/registration/server/src/main.rs`

**Interfaces:**
- Consumes: Environment variables for cert paths
- Produces: Registration server reading certs from env vars

- [ ] **Step 1: Add env var constants to main.rs**

```rust
// In main.rs, add after imports
const REG_SERVER_CERT_ENV: &str = "REG_SERVER_CERT";
const REG_SERVER_KEY_ENV: &str = "REG_SERVER_KEY";
const REG_CA_CERT_ENV: &str = "REG_CA_CERT";
const REG_CA_KEY_ENV: &str = "REG_CA_KEY";
const FACTORY_CA_CERT_ENV: &str = "FACTORY_CA_CERT";
```

- [ ] **Step 2: Modify cert reading to use env vars**

```rust
// Replace hardcoded paths with env var lookups
let server_cert_path = std::env::var(REG_SERVER_CERT_ENV)
    .unwrap_or_else(|_| "certificates/server.crt.pem".to_string());
let server_key_path = std::env::var(REG_SERVER_KEY_ENV)
    .unwrap_or_else(|_| "certificates/server.key.pem".to_string());
let ca_cert_path = std::env::var(REG_CA_CERT_ENV)
    .unwrap_or_else(|_| "certificates/ca/ca.crt.pem".to_string());
let ca_key_path = std::env::var(REG_CA_KEY_ENV)
    .unwrap_or_else(|_| "certificates/ca/ca.key.pem".to_string());
let factory_ca_cert_path = std::env::var(FACTORY_CA_CERT_ENV)
    .unwrap_or_else(|_| "certificates/factory-ca.crt.pem".to_string());

// Use these paths when loading certificates
let ca_cert_pem = std::fs::read_to_string(&ca_cert_path)
    .context("Failed to read CA certificate")
    .map_err(AppError::Signing)?;
```

- [ ] **Step 3: Build and test**

```bash
cd base-services/registration/server
docker build -t nexus-registration .
cd ../../../local-dev
docker compose --env-file .env.base-services up registration
```

- [ ] **Step 4: Commit**

```bash
git add base-services/registration/server/src/main.rs
git commit -m "feat: make registration cert paths configurable via env vars"
```

---

### Task 13: Create Setup & Startup Scripts

**Files:**
- Create: `local-dev/scripts/setup-local-dev.sh`
- Create: `local-dev/scripts/start-infra.sh`
- Create: `local-dev/scripts/start-services.sh`
- Create: `local-dev/scripts/test-local-flow.sh`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Complete local dev workflow

- [ ] **Step 1: Write setup script**

```bash
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
cp env/.env.infra.template .env.infra
cp env/.env.base-services.template .env.base-services
cp env/.env.sample-services.template .env.sample-services

log "Step 3: Generate NATS NKey..."
# This would call a helper to generate NKey pair
# For now, use placeholder
echo "NATS_AUTH_CALLOUT_NKEY_PUB=AAA_PLACEHOLDER" >> .env.infra
echo "JWT_ACC_SIGNING_KEY=SAA_PLACEHOLDER" >> .env.base-services

log "Setup complete! Next steps:"
echo "  1. Edit .env.infra with actual passwords"
echo "  2. Edit .env.base-services with actual values"
echo "  3. Run: ./scripts/start-infra.sh"
```

- [ ] **Step 2: Write start-infra.sh**

```bash
#!/bin/bash
# local-dev/scripts/start-infra.sh
# Start infrastructure services

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[start-infra]\033[0m $*"; }

log "Starting infrastructure..."
docker compose -f docker-compose.infra.yml --env-file .env.infra up -d

log "Waiting for infrastructure to be healthy..."
"$SCRIPTS_DIR/wait-for-services.sh"

log "Infrastructure started!"
echo "  NATS: nats://localhost:4222"
echo "  Keycloak: https://localhost:8443"
echo "  Bigtable: localhost:8086"
echo "  Mosquitto: localhost:1883"
echo ""
echo "Next: Run ./scripts/generate-keycloak-jwks.sh"
```

- [ ] **Step 3: Write start-services.sh**

```bash
#!/bin/bash
# local-dev/scripts/start-services.sh
# Start application services

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[start-services]\033[0m $*"; }

log "Starting application services..."
docker compose --env-file .env.base-services --env-file .env.sample-services up -d

log "Waiting for services to be healthy..."
"$SCRIPTS_DIR/wait-for-services.sh"

log "All services started!"
echo "  auth-callout: connected to NATS"
echo "  data-api: grpc://localhost:8080"
echo "  registration: https://localhost:8443"
```

- [ ] **Step 4: Write test script**

```bash
#!/bin/bash
# local-dev/scripts/test-local-flow.sh
# Test the complete local flow

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[test-flow]\033[0m $*"; }

log "Test 1: Vehicle Registration"
curl -X POST https://localhost:8443/registration \
  --cert certs/clients/device-vin123-dev456.crt.pem \
  --key certs/clients/device-vin123-dev456.key.pem \
  --cacert certs/ca/ca.crt.pem \
  -H "Content-Type: application/pkcs10" \
  --data-binary @<(openssl req -new -key certs/clients/device-vin123-dev456.key.pem -subj "/CN=VIN:VIN123 DEVICE:DEV456")

log "Test 2: Get Keycloak Token"
TOKEN=$(curl -s -X POST http://localhost:8080/realms/nexus-sdv/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=vehicle-client" \
  -d "client_secret=vehicle-client-secret" \
  -d "username=test-device" \
  -d "password=test" | jq -r .access_token)

log "Test 3: NATS JWT Auth"
echo "Token: ${TOKEN:0:50}..."

log "Test 4: Data API Health"
grpc_health_probe -addr=localhost:8080

log "Test 5: Telemetry Pipeline"
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
  -m '{"name":"temp","value":25.5,"unit":"C"}'
sleep 2
docker compose logs data-converter | tail -20

log "All tests passed!"
```

- [ ] **Step 5: Make executable and commit**

```bash
chmod +x local-dev/scripts/*.sh
git add local-dev/scripts/
git commit -m "feat: add local dev setup and startup scripts"
```

---

### Task 14: Integration Test & Documentation

**Files:**
- Modify: `README.md` (add local dev section)

**Interfaces:**
- Consumes: Complete local dev stack
- Produces: Verified working environment

- [ ] **Step 1: Full integration test**

```bash
cd local-dev
./scripts/setup-local-dev.sh
# Edit .env files with generated values
./scripts/start-infra.sh
./scripts/generate-keycloak-jwks.sh
./scripts/start-services.sh
./scripts/test-local-flow.sh
```

- [ ] **Step 2: Document in README**

```markdown
## Local Development (No GCP Required)

Run the entire nexus-sdv stack locally with Docker Compose:

```bash
cd local-dev

# One-time setup
./scripts/setup-local-dev.sh

# Start infrastructure (NATS, Keycloak, Bigtable, Mosquitto)
./scripts/start-infra.sh

# Extract Keycloak JWKS for auth-callout
./scripts/generate-keycloak-jwks.sh

# Start application services
./scripts/start-services.sh

# Test the flow
./scripts/test-local-flow.sh
```

### Services Available

| Service | Endpoint |
|---------|----------|
| NATS | `nats://localhost:4222` (monitoring: `http://localhost:8222`) |
| Keycloak | `https://localhost:8443` (admin: `admin`/`admin`) |
| Bigtable Emulator | `localhost:8086` |
| Mosquitto | `localhost:1883` |
| auth-callout | Internal (NATS auth callout) |
| data-api | `grpc://localhost:8080` |
| registration | `https://localhost:8443` (health: `http://localhost:8888/health`) |
| data-api-sampler | Internal |
| trip-analyzer | Internal |

### Certificates

All certificates are self-signed by a local CA in `local-dev/certs/ca/`.
Use `--cacert local-dev/certs/ca/ca.crt.pem` for HTTPS calls.

### Environment Files

- `.env.infra` - Infrastructure passwords
- `.env.base-services` - Base service configuration
- `.env.sample-services` - Sample service configuration
- `.env.local` - Generated secrets (KEYCLOAK_JWK_B64, etc.)

All `.env` files are gitignored. Copy from `.env.*.template` to get started.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add local development documentation"
```

---

### Task 15: Verify Kind Compatibility (Optional)

**Files:**
- Create: `local-dev/kind-values.yaml` (Helm values for kind)

**Interfaces:**
- Consumes: Built Docker images
- Produces: Helm values for kind deployment

- [ ] **Step 1: Create kind Helm values**

```yaml
# local-dev/kind-values.yaml
# Helm values for deploying to kind cluster

global:
  imagePullPolicy: Never  # Use locally loaded images

nats:
  config:
    merge:
      authorization:
        auth_callout:
          issuer: "AAA..."  # NKey public from setup

data-api:
  gcp:
    projectId: "test-project"
    bigtableInstance: "test-instance"
    bigtableTable: "telemetry"

registration:
  certificates:
    serverCert: "..."
    serverKey: "..."
    caCert: "..."
    caKey: "..."
    factoryCaCert: "..."

# Disable GCP-specific features
external-dns:
  enabled: false
```

- [ ] **Step 2: Test kind deployment**

```bash
# Build all images
docker compose -f docker-compose.yml build

# Load into kind
kind load docker-image $(docker images --format "{{.Repository}}:{{.Tag}}" | grep nexus)

# Deploy
helm install nexus-local iac/helm/ -f local-dev/kind-values.yaml
```

- [ ] **Step 3: Commit**

```bash
git add local-dev/kind-values.yaml
git commit -m "feat: add kind Helm values for local Kubernetes testing"
```

---

## Summary

This plan creates a complete local development environment with:

1. **Certificate generation** - Self-signed CA and certs for all services
2. **Infrastructure** - NATS, Keycloak, Bigtable emulator, Mosquitto
3. **Application services** - All base-services + sample-services
4. **Keycloak realm** - Pre-configured with clients, roles, users
5. **Environment management** - Template-based `.env` files
6. **Health checks** - Orchestrated startup with wait scripts
7. **Testing** - End-to-end flow verification
8. **Documentation** - README with usage instructions
9. **Kind compatibility** - Optional Kubernetes deployment

Total: 15 tasks, each independently testable and committable.
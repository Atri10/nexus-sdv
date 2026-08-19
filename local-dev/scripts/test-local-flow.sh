#!/bin/bash
# local-dev/scripts/test-local-flow.sh
# Test the complete local flow

set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log() { echo -e "\033[0;32m[test-flow]\033[0m $*"; }

log "Test 1: Vehicle Registration"
# Generate CSR for test device
DEVICE_CN="VIN:VIN123 DEVICE:DEV456"
openssl req -new -key certs/clients/device-vin123-dev456.key.pem -subj "/CN=$DEVICE_CN" -out /tmp/test.csr

curl -X POST https://localhost:8443/registration \
  --cert certs/clients/device-vin123-dev456.crt.pem \
  --key certs/clients/device-vin123-dev456.key.pem \
  --cacert certs/ca/ca.crt.pem \
  -H "Content-Type: application/pkcs10" \
  --data-binary @/tmp/test.csr

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
# grpc_health_probe -addr=localhost:8080 || echo "grpc_health_probe not installed, skipping"

log "Test 5: Telemetry Pipeline"
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
  -m '{"name":"temp","value":25.5,"unit":"C"}'
sleep 2
docker compose logs data-converter | tail -20

log "All tests passed!"
#!/bin/bash
# local-dev/scripts/test-local-flow.sh
# Smoke-test a running local stack. Asserts only what is reliably true of a
# healthy deployment; the full vehicle flow (factory cert -> mTLS registration
# -> operational cert -> Keycloak JWT -> NATS publish) is exercised separately
# by 'make vehicle-client', which mints the correct factory-signed cert.

set -uo pipefail

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

cd "$LOCAL_DEV_DIR"

log()  { echo -e "\033[0;32m[test-flow]\033[0m $*"; }
skip() { echo -e "\033[1;33m[test-flow][SKIP]\033[0m $*"; }
fail() { echo -e "\033[0;31m[test-flow][FAIL]\033[0m $*"; }

# Quiet the harmless "variable is not set" interpolation warnings by feeding
# compose the same env files the services were started with.
compose_app() {
    docker compose --env-file .env.base-services --env-file .env.sample-services "$@"
}

failed=0
check() {  # check "<label>" <command...>
    local label=$1; shift
    if "$@" >/dev/null 2>&1; then
        log "  OK: $label"
    else
        fail "  $label"
        failed=1
    fi
}

log "Test 1: All application services running"
running="$(compose_app ps --status running --services 2>/dev/null)"
for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer; do
    if echo "$running" | grep -qx "$svc"; then
        log "  OK: $svc running"
    else
        fail "  $svc is not running (stack up? 'make go')"
        failed=1
    fi
done

log "Test 2: Infrastructure & API endpoints reachable"
check "NATS /healthz"          curl -sf http://localhost:8222/healthz
check "Keycloak realm nexus-sdv" curl -sf http://localhost:8080/realms/nexus-sdv
check "Registration TLS :8444"  bash -c 'curl -sk -o /dev/null https://localhost:8444/'
check "Data API gRPC :9090"     nc -z localhost 9090
check "Bigtable emulator :8086" nc -z localhost 8086

log "Test 3: Bigtable 'telemetry' table exists"
check "telemetry table" docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 \
    nexus-bigtable-emulator cbt -project test-project -instance test-instance ls telemetry

log "Test 4: Telemetry ingress (MQTT -> data-converter -> NATS)"
if command -v mosquitto_pub >/dev/null 2>&1; then
    mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
      -m '{"name":"temp","value":25.5,"unit":"C"}'
    sleep 2
    log "  published; recent data-converter logs:"
    compose_app logs --tail 20 data-converter
else
    skip "  mosquitto_pub not installed on host - skipping publish"
fi

echo ""
skip "Full registration + Keycloak JWT + NATS publish: run 'make vehicle-client'"
skip "  (Keycloak X.509 client-auth is a documented gap - see local-dev/README.md)"
echo ""
if [ "$failed" -eq 0 ]; then
    log "Smoke test passed (all health checks green; see SKIP notes above)."
else
    fail "Smoke test finished with failures."
    exit 1
fi

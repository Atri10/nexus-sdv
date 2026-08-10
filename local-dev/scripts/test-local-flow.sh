#!/bin/bash
# local-dev/scripts/test-local-flow.sh
# Smoke-test a running local stack. Asserts only what is reliably true of a
# healthy deployment. The full vehicle flow (registration -> Keycloak JWT ->
# NATS publish -> Bigtable) is exercised by Test 5 below via the client-secret
# flow with the per-VIN Keycloak client VIN123; X.509 cert-auth (factory cert
# -> mTLS registration -> operational cert) remains out of scope for local dev.

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
for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer nats-bigtable-connector telemetry-chart-service data-web-client predictive-maintenance; do
    if echo "$running" | grep -qx "$svc"; then
        log "  OK: $svc running"
    else
        fail "  $svc is not running (stack up? 'make go')"
        failed=1
    fi
done

log "Test 2: Infrastructure & API endpoints reachable"
check "NATS /healthz"          curl -sf http://localhost:8222/healthz
check "Keycloak realm nexus-sdv" curl -sf http://localhost:8088/realms/nexus-sdv
check "Registration TLS :8444"  bash -c 'curl -sk -o /dev/null https://localhost:8444/'
check "Data API gRPC :9090"     nc -z localhost 9090
check "Bigtable emulator :8086" nc -z localhost 8086

log "Test 3: Bigtable 'telemetry' table exists"
check "telemetry table" docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 \
    nexus-bigtable-emulator cbt -project test-project -instance test-instance ls telemetry

log "Test 4: Telemetry ingress (MQTT -> data-converter -> NATS -> connector -> Bigtable)"
if command -v mosquitto_pub >/dev/null 2>&1; then
    mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
      -m '{"name":"temp","value":25.5,"unit":"C"}'
    sleep 5
    log "  published; recent data-converter logs:"
    compose_app logs --tail 20 data-converter
    log "  connector logs:"
    compose_app logs --tail 20 nats-bigtable-connector
    log "  checking Bigtable for VIN123 row..."
    check "Bigtable has VIN123 row" \
      docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 \
        nexus-bigtable-emulator cbt -project test-project -instance test-instance read telemetry \
        | grep -q "VIN123"
else
    skip "  mosquitto_pub not installed on host - skipping publish"
fi

echo ""
log "Test 5: Vehicle flow (registration -> Keycloak JWT -> NATS publish -> Bigtable)"
if command -v go >/dev/null 2>&1 && command -v protoc >/dev/null 2>&1 \
   && command -v jq >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
    count_rows() {
        docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 \
            nexus-bigtable-emulator cbt -project test-project -instance test-instance \
            read telemetry 2>/dev/null | grep -c "VIN123#"
    }
    before=$(count_rows || true)
    log "  VIN123 rows before: $before"
    log "  starting vehicle-client (up to 35s for registration + first publish)..."
    bash scripts/run-vehicle-client.sh --vin "${VIN:-VIN123}" >/tmp/vehicle-client-smoke.log 2>&1 &
    smoke_pid=$!
    sleep 35
    kill "$smoke_pid" 2>/dev/null || true
    pkill -x vehicle-client 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
    after=$(count_rows || true)
    log "  VIN123 rows after: $after"
    if [ "$after" -gt "$before" ]; then
        log "  OK: vehicle flow published new telemetry rows"
    else
        fail "  vehicle flow produced no new rows (see /tmp/vehicle-client-smoke.log)"
        failed=1
    fi
else
    skip "  go/protoc/jq/openssl not all on PATH - skipping vehicle flow"
fi
echo ""
log "Test 6: Predictive-maintenance loop (detector polls data-api, publishes pm.*)"
# Deterministic by design (Task 3 §publish-cadence): healthy VINs publish
# nothing, so the stable assertion is that the detector's poll loop is
# alive (its "Polling data-api ..." line). The pm.* publish assertion is
# best-effort: it only fires when a degrading VIN is in the pool (the
# default DEGRADATION_PRESET=demo gives the pool's first VIN the
# "critical" preset) AND the detector has accumulated enough telemetry
# (30 days of resting voltage for the battery slope, 14 tire samples).
# Run the stack with DEGRADATION_PRESET=critical for a deterministic
# publish within one poll cycle.
PM_LOGS="$(compose_app logs --tail 200 predictive-maintenance 2>/dev/null || true)"
if printf '%s' "$PM_LOGS" | grep -q "Data poll failed"; then
    fail "  predictive-maintenance logged a data poll error"
    failed=1
else
    log "  OK: no data poll errors"
fi
if printf '%s' "$PM_LOGS" | grep -q "Polling data-api"; then
    log "  OK: detector polling loop alive"
else
    fail "  predictive-maintenance not polling data-api (service up? see 'make pm-demo')"
    failed=1
fi
SUBJECT_LINE="$(printf '%s' "$PM_LOGS" | grep -m1 "pm\." || true)"
if [ -z "$SUBJECT_LINE" ]; then
    skip "  no pm.* publish in the last 200 log lines (healthy VINs publish nothing by design; use DEGRADATION_PRESET=critical for a deterministic alert)"
else
    log "  OK: predictive-maintenance published $(printf '%s' "$SUBJECT_LINE" | sed -E 's/.*(pm\.[^ ]+).*/\1/')"
fi
echo ""
if [ "$failed" -eq 0 ]; then
    log "Smoke test passed (all health checks green)."
else
    fail "Smoke test finished with failures."
    exit 1
fi

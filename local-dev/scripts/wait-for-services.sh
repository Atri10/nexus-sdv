#!/bin/bash
# local-dev/scripts/wait-for-services.sh
# Waits for all local services to be healthy

log() { echo -e "\033[0;32m[wait-for-services]\033[0m $*"; }
error() { echo -e "\033[0;31m[wait-for-services]\033[0m $*" >&2; }

failed=0

wait_for() {
    local name=$1
    shift
    local max_attempts=${1:-30}
    shift || true
    local delay=${1:-2}
    shift || true
    local i
    log "Waiting for $name..."
    for i in $(seq 1 "$max_attempts"); do
        if "$@" > /dev/null 2>&1; then
            log "$name is healthy"
            return 0
        fi
        sleep "$delay"
    done
    error "$name failed health check after $((max_attempts * delay)) seconds"
    return 1
}

wait_for "NATS" 30 2 curl -f http://localhost:8222/healthz || failed=1
wait_for "Keycloak" 30 2 curl -f http://localhost:8088/realms/nexus-sdv || failed=1
wait_for "Bigtable Emulator" 30 2 nc -z localhost 8086 || failed=1
wait_for "Mosquitto" 30 2 nc -z localhost 1883 || failed=1

if [ "$failed" -eq 0 ]; then
    log "All services are healthy!"
    exit 0
else
    error "One or more services failed health checks"
    exit 1
fi
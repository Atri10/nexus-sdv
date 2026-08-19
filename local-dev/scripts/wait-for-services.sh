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

# Health checks for infrastructure services
wait_for "NATS" "curl -f http://localhost:8222/healthz"
wait_for "Keycloak" "curl -f http://localhost:8080/health/ready"
wait_for "Bigtable Emulator" "nc -z localhost 8086"
wait_for "Mosquitto" "nc -z localhost 1883"

# Health checks for application services
wait_for "auth-callout" "nc -z localhost 4222"
wait_for "data-api" "nc -z localhost 8080"
wait_for "registration" "curl -f http://localhost:8888/health"

log "All services are healthy!"
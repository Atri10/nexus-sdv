#!/bin/bash
set -euo pipefail

# local-dev/scripts/query-bigtable.sh
# Query Bigtable emulator for telemetry data.
#
# Runs 'cbt' inside the nexus-bigtable-emulator container (the
# gcr.io/google.com/cloudsdktool/cloud-sdk image it's built from ships
# gcloud, so 'cbt' is installed there as a gcloud component on first use)
# rather than requiring a local Go toolchain / gcloud install on the host.

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[bigtable]${NC} $*"; }
info() { echo -e "${BLUE}[info]${NC} $*"; }

cd "$LOCAL_DEV_DIR"

CONTAINER="nexus-bigtable-emulator"
PROJECT="test-project"
INSTANCE="test-instance"
TABLE="telemetry"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "ERROR: $CONTAINER is not running. Start it with 'make go' first." >&2
    exit 1
fi

exec_in_container() {
    docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 "$CONTAINER" "$@"
}

# Ensure cbt is available inside the container (installed once, then cached
# for the life of the container).
if ! exec_in_container which cbt > /dev/null 2>&1; then
    log "cbt not found in $CONTAINER, installing gcloud component..."
    exec_in_container gcloud components install cbt --quiet > /dev/null
fi

log "Querying Bigtable Emulator"
log "Project: $PROJECT"
log "Instance: $INSTANCE"
log "Table: $TABLE"
echo ""

# Check if a specific row key was provided
ROW_KEY="${1:-}"

if [ -n "$ROW_KEY" ]; then
    info "Reading row: $ROW_KEY"
    # 'lookup' fetches a single row by its full key. ('read <table> <key>' is
    # not valid cbt syntax - 'read' takes prefix=/start=/end=/regex=, not a
    # bare positional row key.)
    exec_in_container cbt -project "$PROJECT" -instance "$INSTANCE" lookup "$TABLE" "$ROW_KEY"
else
    info "Reading all rows from table..."
    echo ""
    exec_in_container cbt -project "$PROJECT" -instance "$INSTANCE" read "$TABLE"
    echo ""
    info "Use './scripts/query-bigtable.sh <row-key>' to read a specific row"
    info "Example: './scripts/query-bigtable.sh \"VIN123#2026-07-13T17:00:00.000000000Z\"'"
fi

echo ""
log "Query complete!"

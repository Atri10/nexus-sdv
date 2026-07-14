#!/bin/bash
# local-dev/scripts/ingest-sample.sh
# Write one sample telemetry row directly into the Bigtable emulator.
#
# Why this exists: local dev has NO NATS -> Bigtable writer. data-converter
# only forwards MQTT -> NATS, and the vehicle-client only publishes to NATS -
# nothing consumes those messages into Bigtable. So to give 'make query' and
# the data-api something to read, rows must be written directly here.
#
# Row key / column layout matches exactly what data-api expects
# (see base-services/data-api/src/service/bigtable.go & time.go):
#   - row key:  "<VIN>#<RFC3339-nano timestamp>"
#               e.g. VIN123#2026-07-13T17:00:00.000000000Z
#   - columns:  "<family>:<qualifier>" in family "dynamic" or "static"
#               e.g. dynamic:speed, static:make
#
# Usage:
#   ./ingest-sample.sh [VIN] [TIMESTAMP]
#   VIN        defaults to VIN123
#   TIMESTAMP  defaults to now (UTC), in the format data-api parses
set -euo pipefail

SCRIPTS_DIR="$(dirname "$0")"
cd "$SCRIPTS_DIR/.."

CONTAINER="nexus-bigtable-emulator"
PROJECT="test-project"
INSTANCE="test-instance"
TABLE="telemetry"

VIN="${1:-VIN123}"
TS="${2:-$(date -u +%Y-%m-%dT%H:%M:%S.000000000Z)}"
ROWKEY="${VIN}#${TS}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "ERROR: $CONTAINER is not running. Start the stack with 'make go' first." >&2
    exit 1
fi

cbt() {
    docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 "$CONTAINER" cbt \
        -project "$PROJECT" -instance "$INSTANCE" "$@"
}

# Install cbt on first use (it's a gcloud component shipped in the emulator image).
if ! docker exec "$CONTAINER" which cbt >/dev/null 2>&1; then
    docker exec "$CONTAINER" gcloud components install cbt --quiet >/dev/null
fi

# The emulator keeps everything in memory: a container restart (Docker restart,
# laptop sleep) wipes the table created during setup. Re-create it on demand so
# this script works regardless of how the emulator was last started.
if ! cbt ls "$TABLE" >/dev/null 2>&1; then
    echo "[ingest] table '$TABLE' missing (emulator has no persistence) - creating table + families..."
    cbt createtable "$TABLE" >/dev/null
    cbt createfamily "$TABLE" dynamic >/dev/null
    cbt createfamily "$TABLE" static >/dev/null
fi

echo "[ingest] writing row '$ROWKEY' to table '$TABLE'..."
cbt set "$TABLE" "$ROWKEY" \
    dynamic:speed=72 \
    dynamic:battery.soc=85.5 \
    dynamic:battery.temp=25.3 \
    static:make=Ford \
    static:model=F150

echo "[ingest] done. Read it back with:"
echo "  make query                                   # all rows"
echo "  bash scripts/query-bigtable.sh '$ROWKEY'     # just this row"

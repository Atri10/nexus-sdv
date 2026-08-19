#!/bin/bash
set -euo pipefail

# local-dev/scripts/query-bigtable.sh
# Query Bigtable emulator for telemetry data

SCRIPTS_DIR="$(dirname "$0")"
LOCAL_DEV_DIR="$SCRIPTS_DIR/.."

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[bigtable]${NC} $*"; }
info() { echo -e "${BLUE}[info]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

cd "$LOCAL_DEV_DIR"

# Check if cbt is installed
if ! command -v cbt &> /dev/null; then
    warn "cbt (Cloud Bigtable CLI) not found. Installing..."
    go install github.com/googleapis/cloud-bigtable/cmd/cbt@latest
    # Add to PATH if needed
    export PATH="$PATH:$(go env GOPATH)/bin"
fi

# Configuration
PROJECT="test-project"
INSTANCE="test-instance"
TABLE="telemetry"
BIGTABLE_HOST="${BIGTABLE_EMULATOR_HOST:-localhost:8086}"

log "Querying Bigtable Emulator"
log "Host: $BIGTABLE_HOST"
log "Project: $PROJECT"
log "Instance: $INSTANCE"
log "Table: $TABLE"
echo ""

# Check if a specific row key was provided
ROW_KEY="${1:-}"

if [ -n "$ROW_KEY" ]; then
    info "Reading row: $ROW_KEY"
    BIGTABLE_EMULATOR_HOST="$BIGTABLE_HOST" cbt -project "$PROJECT" -instance "$INSTANCE" read "$TABLE" "$ROW_KEY"
else
    info "Reading all rows from table..."
    echo ""
    BIGTABLE_EMULATOR_HOST="$BIGTABLE_HOST" cbt -project "$PROJECT" -instance "$INSTANCE" read "$TABLE" | head -100
    echo ""
    info "Use './scripts/query-bigtable.sh <row-key>' to read a specific row"
    info "Example: './scripts/query-bigtable.sh VIN123/2026-07-13'"
fi

echo ""
log "Query complete!"

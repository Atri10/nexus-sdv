# NATS→Bigtable Ingestion Verification & Java Chart Service Fixes

**Date:** 2026-07-18  
**Status:** Draft  
**Branch:** `feat/local-dev-no-gcp`

---

## 1. Problem Statement

The local development environment has an architectural gap: telemetry data published via MQTT should flow through NATS into Bigtable, but the ingestion path is unverified. Additionally, the Java `telemetry-chart-service` (which reads from Bigtable to serve live charts via REST/WebSocket) has row-key format mismatches that prevent it from querying data written by the Go connector.

**Current state:**
- Go `nats-bigtable-connector` exists (commit d5e5db6) but untested end-to-end
- Java `telemetry-chart-service` reads Bigtable but uses wrong timestamp format for query bounds
- `make test` Test 4 (MQTT → Bigtable) likely fails
- Frontend (TypeScript/Chart.js) cannot display live data

**Desired state:**
- `make test` passes completely (all 4 tests green)
- Go connector reliably ingests: MQTT → data-converter → NATS → Bigtable
- Java service queries correctly using same row-key format
- Frontend displays live telemetry charts via REST + WebSocket

---

## 2. Architecture Overview

```mermaid
flowchart LR
  subgraph Ingress["Ingress (local)"]
    MQTT["MQTT publisher<br/>telemetry/VIN123/sensors/temp"]
    MQTT -->|"telemetry/+/sensors/#"| DC["data-converter<br/>(MQTT → TelemetryMessage)"]
    DC -->|"telemetry-generic.VIN123.temp"| NATS[(NATS :4222)]
  end

  subgraph Storage["Storage"]
    CONN["nats-bigtable-connector<br/>(Go, telemetry-generic.>)"]
    NATS --> CONN
    CONN -->|"row VIN123#2026-07-18T...<br/>col dynamic:temp=25.5"| BT[("Bigtable Emulator :8086")]
  end

  subgraph Display["Display"]
    JAVA["telemetry-chart-service<br/>(Java :8081)"]
    BT -->|"REST / WS query"| JAVA
    WEB["data-web-client<br/>(TypeScript :3000)"]
    JAVA -->|"REST / WebSocket"| WEB
    WEB --> CHART["Chart.js live charts"]
  end
```

**Service Responsibilities (clear separation):**

**Service Responsibilities (clear separation):**

| Service | Language | Role | Direction |
|---------|----------|------|-----------|
| `nats-bigtable-connector` | Go | **Ingestion only** | NATS → Bigtable (write) |
| `telemetry-chart-service` | Java/Spring Boot | **Read/Display only** | Bigtable → REST/WS → Frontend |
| `data-web-client` | TypeScript/React | **Visualization** | Consumes Java REST/WS → Chart.js |

---

## 3. Phase 1: Go Connector Verification & Fixes

### 3.1 Test Procedure

```bash
# Full stack startup
cd local-dev
make go          # or: make setup-auto && docker compose up -d

# Run smoke test (includes Test 4: MQTT → Bigtable)
make test
```

**Test 4 details** (`scripts/test-local-flow.sh` lines 58-74):
1. Publishes MQTT: `mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" -m '{"name":"temp","value":25.5,"unit":"C"}'`
2. Waits 5s for propagation
3. Checks Bigtable for row with key prefix `VIN123`

### 3.2 Failure Matrix & Fixes

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `data-converter` logs show no MQTT received | Mosquitto not reachable / topic mismatch | Verify `data-converter.yaml` topic `telemetry/+/sensors/#` matches publish topic |
| `data-converter` receives MQTT but no NATS publish | NATS connection / auth failure | Check `NATS_URL`, `NATS_USER`, `NATS_PASSWORD` in compose |
| `nats-bigtable-connector` logs "Failed to unmarshal" | Protobuf schema mismatch | Ensure both use same `telemetry.proto` (Go: `api/gen/telemetry`, Java: generates from same proto) |
| Connector receives msg but no Bigtable write | Bigtable client / emulator connection | Verify `BIGTABLE_EMULATOR_HOST`, project/instance/table names |
| Bigtable row key format wrong | Timestamp format mismatch | Go uses `2006-01-02T15:04:05.000000000Z07:00` (RFC3339Nano) — **canonical format** |
| `make query` returns no rows | Row key format / column family mismatch | Verify row key = `VIN#<RFC3339Nano>`, families `dynamic:` / `static:` |

### 3.3 Verification Commands

```bash
# Check data-converter logs
docker compose logs data-converter --tail 50

# Check connector logs
docker compose logs nats-bigtable-connector --tail 50

# Manual Bigtable query
docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
  cbt -project test-project -instance test-instance read telemetry

# Manual MQTT publish + verify
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" -m '{"name":"temp","value":25.5,"unit":"C"}'
make query
```

### 3.4 Acceptance Criteria (Phase 1)

- [ ] `make test` exits 0 (all 4 tests pass)
- [ ] Test 4 specifically: Bigtable contains row with key `VIN123#<timestamp>` and column `dynamic:temp=25.5`
- [ ] Connector logs show successful protobuf decode and Bigtable write
- [ ] No errors in `data-converter` or `nats-bigtable-connector` logs

---

## 4. Phase 2: Java Service Read Path Fixes

### 4.1 Root Cause: Row Key Format Mismatch

**Go connector writes:** `VIN123#2026-07-18T15:04:05.000000000Z` (RFC3339Nano)  
**Java `TelemetryService.buildRowKey()` uses:** `yyyyMMddHHmmssSSS` (e.g., `20260718150405123`)  
**Java `TelemetryService.parseRow()` uses:** `Instant.parse(tsStr)` — expects RFC3339Nano

**Problem:** Query bounds (`buildRowKey`) don't match stored keys → range scans return empty.

### 4.2 Required Changes

#### File: `TelemetryService.java`

**Change 1: Canonical timestamp format constant**
```java
// Replace TIMESTAMP_FORMAT and FORMATTER
private static final String BIGTABLE_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSSSSX"; // RFC3339Nano
private static final DateTimeFormatter BIGTABLE_FORMATTER = 
    DateTimeFormatter.ofPattern(BIGTABLE_TIMESTAMP_FORMAT).withZone(ZoneOffset.UTC);
```

**Change 2: `buildRowKey` uses canonical format**
```java
private String buildRowKey(String vehicleId, Instant timestamp) {
    String ts = BIGTABLE_FORMATTER.format(timestamp);
    return vehicleId + "#" + ts;
}
```

**Change 3: `parseRow` already works** — `Instant.parse()` handles RFC3339Nano. Keep as-is.

**Change 4: `getLatestTelemetry` row range end key**
```java
// Current: vehicleId + "~" (works for prefix scan but not precise)
// Better: use open-ended range or precise end bound
String startKey = vehicleId + "#";
String endKey = vehicleId + "0"; // Lexicographically after all timestamps for this VIN
RowRange rowRange = RowRange.of(startKey, true, endKey, false);
```

### 4.3 Additional Polish (Optional but Recommended)

| Improvement | Description |
|-------------|-------------|
| Dynamic vehicle list | Replace hardcoded `listVehicles()` with Bigtable scan for distinct VIN prefixes |
| WebSocket backpressure | Add session limit, configurable poll interval |
| Health endpoint | Add `/actuator/health` check for Bigtable connectivity |
| Column family constants | Define `DYNAMIC_FAMILY = "dynamic"`, `STATIC_FAMILY = "static"` |

### 4.4 Acceptance Criteria (Phase 2)

- [ ] `TelemetryService.queryTelemetry(vin, start, end, columns)` returns rows written by Go connector
- [ ] `getLatestTelemetry(vin)` returns most recent row
- [ ] WebSocket `/api/v1/vehicles/{vin}/telemetry/live` pushes updates (polling-based)
- [ ] Unit tests pass: `mvn test -pl telemetry-chart-service`

---

## 5. Phase 3: Frontend Integration Verification

### 5.1 Existing Frontend Components

| File | Purpose |
|------|---------|
| `sample-clients/data-web-client/src/components/telemetry-chart/TelemetryChart.tsx` | Chart.js line chart component |
| `sample-clients/data-web-client/src/app/api/telemetry/[vin]/route.ts` | Next.js API route proxying to Java service |
| `sample-clients/data-web-client/src/app/device/[id]/page.tsx` | Device page consuming chart |

### 5.2 Integration Flow

```mermaid
sequenceDiagram
  autonumber
  participant FE as Frontend :3000
  participant R as Next.js API Route
  participant J as Java Service :8081
  participant BT as Bigtable Emulator :8086

  FE->>R: GET /api/telemetry/VIN123?start=...&end=...&limit=100
  R->>J: GET /api/v1/vehicles/VIN123/telemetry?...
  J->>BT: Bigtable scan
  BT-->>J: rows
  J-->>R: JSON response
  R-->>FE: telemetry series
  FE->>FE: Chart.js renders live data
```

### 5.3 WebSocket Live Updates

```mermaid
sequenceDiagram
  autonumber
  participant FE as Frontend
  participant WS as TelemetryWebSocketHandler :8081
  participant BT as Bigtable

  FE->>WS: WebSocket /ws/telemetry?vin=VIN123&columns=dynamic:temp
  WS->>WS: subscribe session to vehicle + columns
  loop every 1 s
    WS->>BT: getLatestTelemetry
    BT-->>WS: rows
    WS-->>FE: broadcast { timestamp, values }
  end
  FE->>FE: Chart.js appends point
```

### 5.4 Acceptance Criteria (Phase 3)

- [ ] Frontend at `localhost:3000` loads device page
- [ ] Chart displays historical data from Bigtable (last hour by default)
- [ ] New MQTT publishes appear on chart within ~2s (polling interval)
- [ ] Multiple sensors/columns render as separate lines
- [ ] No console errors in browser devtools

---

## 6. Protobuf Sharing Strategy

**Single source of truth:** `base-services/nats-bigtable-connector/proto/telemetry.proto` (same as `base-services/data-converter/api/telemetry.proto`)

### Go (nats-bigtable-connector)
- `protoc --go_out=api/gen/telemetry` in Dockerfile.local
- Imports as `telemetry "nats-bigtable-connector/api/gen/telemetry"`

### Java (telemetry-chart-service)
- Add `protobuf-maven-plugin` to `pom.xml`
- Configure to read proto from `../../../base-services/nats-bigtable-connector/proto/telemetry.proto`
- Generated classes in `target/generated-sources/protobuf/...`
- Use in `TelemetryService` for any future protobuf needs (currently reads raw bytes)

**Note:** Java service currently reads raw Bigtable bytes (strings), not protobuf. Proto sharing ensures future compatibility if Java ever needs to decode NATS messages directly.

---

## 7. Docker Compose Configuration

### 7.1 Current (Verified Working)

```yaml
# local-dev/docker-compose.yml (already has these)
nats-bigtable-connector:
  build:
    context: ../base-services/nats-bigtable-connector
    dockerfile: Dockerfile.local
  environment:
    - NATS_URL=nats://connector:connector-pass@nats:4222
    - BIGTABLE_EMULATOR_HOST=bigtable-emulator:8086
    - GCP_PROJECT=test-project
    - BT_INSTANCE=test-instance
    - BT_TABLE=telemetry

telemetry-chart-service:
  build:
    context: ../sample-services/telemetry-chart-service
    dockerfile: Dockerfile.local
  environment:
    - BIGTABLE_PROJECT_ID=test-project
    - BIGTABLE_INSTANCE_ID=test-instance
    - BIGTABLE_TABLE_NAME=telemetry
    - BIGTABLE_EMULATOR_HOST=bigtable-emulator:8086
  ports:
    - "8081:8080"
  depends_on:
    - bigtable-emulator
```

**No changes needed** — both services already configured correctly.

---

## 8. Testing Strategy

### 8.1 Test Pyramid

| Level | Command | Scope |
|-------|---------|-------|
| **Unit (Java)** | `mvn test -pl telemetry-chart-service` | `TelemetryService` logic, row key parsing, filters |
| **Integration (Local Stack)** | `make test` | Full MQTT → NATS → Go → BT → Java → Frontend |
| **Manual E2E** | `mosquitto_pub ... && make query` | Ad-hoc verification |
| **Frontend** | `npm test` in `data-web-client` | Chart component rendering |

### 8.2 Phase-Gated Acceptance

| Phase | Gate | Command |
|-------|------|---------|
| 1 | Go connector works | `make test` → exit 0 |
| 2 | Java reads correctly | `mvn test` + manual `curl localhost:8081/api/v1/vehicles/VIN123/telemetry` |
| 3 | Frontend displays live | Open `localhost:3000/device/VIN123`, publish MQTT, verify chart updates |

---

## 9. Rollback / Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Go connector has fundamental bug | Can always use `make ingest` (manual Bigtable write) to seed data for Java/frontend testing |
| Java row key fix breaks existing queries | `buildRowKey` only used for *new* queries; stored keys unchanged. `parseRow` already handles RFC3339Nano. |
| Frontend port conflicts | Frontend runs on 3000, Java on 8081, data-api on 9090 — no overlap |
| Protobuf regeneration breaks build | Proto is stable; both Go and Java generate at build time in Docker |

---

## 10. Implementation Order

1. **Phase 1**: Run `make test`, diagnose failures, apply fixes to Go connector / data-converter / compose
2. **Phase 2**: Apply `TelemetryService.java` timestamp format fixes, run Java unit tests
3. **Phase 3**: Start full stack, verify frontend chart updates live
4. **Commit**: All fixes in single PR with updated spec

---

## 11. Success Definition

**The feature is complete when:**

```bash
cd local-dev
make go          # Stack starts cleanly
make test        # ✅ All 4 tests pass (including Test 4: MQTT → Bigtable)
# In another terminal:
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/speed" -m '{"name":"speed","value":72.5,"unit":"km/h"}'
# Frontend at http://localhost:3000/device/VIN123 shows:
#   - Historical data loaded on page load
#   - New "speed" line appears within 2s with value 72.5
```

---

## Appendix: Key Files to Modify

| Phase | File | Change Type |
|-------|------|-------------|
| 1 | `base-services/nats-bigtable-connector/src/main.go` | Fixes (if any) |
| 1 | `local-dev/config/data-converter.yaml` | Topic/subject alignment (if needed) |
| 2 | `sample-services/telemetry-chart-service/src/main/java/.../service/TelemetryService.java` | Timestamp format fixes |
| 2 | `sample-services/telemetry-chart-service/pom.xml` | Add `protobuf-maven-plugin` (for proto sharing) |
| 3 | `sample-clients/data-web-client/` | Verify only (no changes expected) |

---

*Spec self-review completed: no TBDs, no contradictions, scope focused on verification + targeted fixes.*
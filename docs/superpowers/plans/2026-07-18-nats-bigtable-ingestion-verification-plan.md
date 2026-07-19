# NATS→Bigtable Ingestion Verification & Java Chart Service Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify end-to-end MQTT→NATS→Bigtable ingestion works, fix Java TelemetryService row key format mismatch, and verify frontend live chart integration — all 4 `make test` tests passing, Java unit tests passing, frontend displaying live data.

**Architecture:** Three-phase approach: (1) Verify/fix Go connector ingestion path using existing `make test` script, (2) Fix Java `TelemetryService` row key timestamp format to match Go's RFC3339Nano format, (3) Start full stack and verify frontend chart displays live data via REST + WebSocket.

**Tech Stack:** Go (nats-bigtable-connector), Java/Spring Boot (telemetry-chart-service), TypeScript/Next.js/Chart.js (data-web-client), Docker Compose (local-dev), Bigtable Emulator, NATS, Mosquitto MQTT

## Global Constraints

- Branch: `feat/local-dev-no-gcp` (already checked out)
- Working directory: `local-dev/` for all `make` commands
- Go connector row key format (canonical): `VIN#2006-01-02T15:04:05.000000000Z07:00` (RFC3339Nano)
- Java `TelemetryService` currently uses `yyyyMMddHHmmssSSS` for row key build, `Instant.parse()` for parse — parse works, build/query bounds broken
- Java `TelemetryController` expects ISO-8601 query params, calls `TelemetryService` with `Instant` objects
- Frontend at `localhost:3000` proxies to Java at `localhost:8081` via Next.js API routes
- Java service port `8081` (Docker), `8080` (local Maven); Bigtable emulator `localhost:8086`
- Protobuf shared from `base-services/nats-bigtable-connector/proto/telemetry.proto`

---

### Phase 1: Go Connector Verification & Fixes

#### Task 1.1: Run Full Stack & Baseline Test

**Files:**
- Run: `local-dev/Makefile`, `local-dev/go.sh`, `local-dev/scripts/test-local-flow.sh`

**Interfaces:**
- Consumes: Existing docker-compose stack
- Produces: Test 1-4 pass/fail status, logs for diagnosis

**Steps:**

- [ ] **Step 1: Start full stack**
  ```bash
  cd local-dev
  make go
  # Wait for "All services online and ready to use!" (~60-90s)
  ```

- [ ] **Step 2: Run smoke test to establish baseline**
  ```bash
  make test
  # Expected: Test 1-3 pass, Test 4 likely fails (MQTT → Bigtable ingestion)
  ```

- [ ] **Step 3: Capture failure details**
  ```bash
  # If Test 4 fails, check logs:
  docker compose --env-file .env.base-services --env-file .env.sample-services logs data-converter --tail 50
  docker compose --env-file .env.base-services --env-file .env.sample-services logs nats-bigtable-connector --tail 50
  # Check Bigtable directly:
  docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
    cbt -project test-project -instance test-instance read telemetry
  ```

**Expected Output:** Test 1-3 OK. Test 4 shows whether MQTT message reaches Bigtable. If row `VIN123#...` exists with `dynamic:temp=25.5`, ingestion works.

**Decision Points:**
- If Test 4 passes → Phase 1 complete, skip to Phase 2
- If data-converter logs show MQTT received but no NATS publish → check NATS auth/connection (Step 4)
- If connector logs show "Failed to unmarshal" → protobuf mismatch (Step 5)
- If connector receives but no Bigtable write → Bigtable connection/emulator issue (Step 6)

#### Task 1.2: Verify data-converter Topic Mapping

**Files:**
- Read: `local-dev/config/data-converter.yaml:16-30`
- No edits expected unless topic mismatch

**Steps:**

- [ ] **Step 1: Verify MQTT topic matches data-converter source**
  ```bash
  # data-converter subscribes to: telemetry/+/sensors/#
  # test-local-flow.sh publishes to: telemetry/VIN123/sensors/temp
  # These MATCH — device_id = VIN123, sensor = temp
  ```

- [ ] **Step 2: Verify NATS subject pattern**
  ```yaml
  # data-converter.yaml target:
  subject_pattern: 'telemetry-generic.{{ .device_id }}.{{ .sensor }}'
  # Produces: telemetry-generic.VIN123.temp
  ```

- [ ] **Step 3: Verify Go connector subscription**
  ```go
  // main.go:59
  nc.Subscribe("telemetry-generic.>", ...)
  // Matches: telemetry-generic.VIN123.temp ✓
  ```

**Decision Point:** If topics mismatch, edit `data-converter.yaml:29` subject_pattern to match Go connector expectation.

#### Task 1.3: Verify Protobuf Schema Alignment

**Files:**
- Read: `base-services/nats-bigtable-connector/proto/telemetry.proto`
- Read: `base-services/data-converter/` (check if it uses same proto)

**Steps:**

- [ ] **Step 1: Confirm both services use same protobuf**
  ```bash
  # Go connector imports:
  telemetry "nats-bigtable-connector/api/gen/telemetry"
  # Generated from: base-services/nats-bigtable-connector/proto/telemetry.proto
  
  # data-converter should generate from same proto
  ```

- [ ] **Step 2: If data-converter uses different proto, align**
  - Copy `telemetry.proto` to data-converter proto dir
  - Regenerate Go code in data-converter
  - Rebuild data-converter image: `docker compose build data-converter`

**Expected:** Both services marshal/unmarshal `TelemetryMessage` with `device_id`, `sensor_data[]` (timestamp, value, data_type, sensor)

#### Task 1.4: Fix Go Connector Bigtable Write Issues

**Files:**
- Modify: `base-services/nats-bigtable-connector/src/main.go:71-100`

**Interfaces:**
- Consumes: NATS message with `TelemetryMessage` protobuf
- Produces: Bigtable row with key `device_id#RFC3339Nano`, columns `dynamic:<sensor>=value` or `static:<sensor>=value`

**Steps:**

- [ ] **Step 1: Verify timestamp format in Go connector**
  ```go
  // main.go:73-74 — CORRECT format (RFC3339Nano)
  ts := reading.Timestamp.AsTime()
  timestampStr := ts.Format("2006-01-02T15:04:05.000000000Z07:00")
  ```

- [ ] **Step 2: Verify row key construction**
  ```go
  // main.go:87
  rowKey := fmt.Sprintf("%s#%s", tm.DeviceId, timestampStr)
  // Example: VIN123#2026-07-18T15:04:05.000000000Z
  ```

- [ ] **Step 3: Verify column family mapping**
  ```go
  // main.go:76-82
  family := "dynamic"
  switch reading.DataType {
  case telemetry.DataType_STATIC:
      family = "static"
  case telemetry.DataType_DYNAMIC:
      family = "dynamic"
  }
  mut.Set(family, reading.Sensor, bigtable.Now(), []byte(reading.Value))
  ```

- [ ] **Step 4: If any bug found, edit main.go and rebuild**
  ```bash
  cd local-dev
  docker compose build nats-bigtable-connector
  docker compose up -d nats-bigtable-connector
  ```

#### Task 1.5: Verify Bigtable Emulator Connectivity

**Files:**
- Run: `local-dev/scripts/query-bigtable.sh`

**Steps:**

- [ ] **Step 1: Check emulator is reachable**
  ```bash
  nc -z localhost 8086
  ```

- [ ] **Step 2: Verify table and families exist**
  ```bash
  docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
    cbt -project test-project -instance test-instance ls telemetry
  # Should show: telemetry (with families: dynamic, static)
  ```

- [ ] **Step 3: If table missing, create it (ingest-sample.sh does this)**
  ```bash
  make ingest
  # Or manually:
  docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 nexus-bigtable-emulator \
    cbt -project test-project -instance test-instance createtable telemetry
  docker exec ... createfamily telemetry dynamic
  docker exec ... createfamily telemetry static
  ```

#### Task 1.6: Re-run Test & Confirm Phase 1 Pass

**Steps:**

- [ ] **Step 1: Run full test suite**
  ```bash
  cd local-dev
  make test
  ```

- [ ] **Step 2: Verify Test 4 passes**
  ```bash
  # Output should show:
  # [test-flow] Test 4: Telemetry ingress...
  # [test-flow]   OK: Bigtable has VIN123 row
  ```

- [ ] **Step 3: Manual verification with query**
  ```bash
  make query
  # Should show rows like: VIN123#2026-07-18T15:04:05.000000000Z  dynamic:temp=25.5
  ```

**Acceptance Criteria (Phase 1):**
- [ ] `make test` exits 0 (all 4 tests pass)
- [ ] Test 4: Bigtable contains row with key `VIN123#<RFC3339Nano>` and column `dynamic:temp=25.5`
- [ ] Connector logs show successful protobuf decode and Bigtable write
- [ ] No errors in `data-converter` or `nats-bigtable-connector` logs

**Rollback Phase 1:**
```bash
cd local-dev
make stop
git checkout base-services/nats-bigtable-connector/src/main.go
docker compose build nats-bigtable-connector
make go
```

---

### Phase 2: Java Service Row Key Format Fixes

#### Task 2.1: Examine Current TelemetryService Implementation

**Files:**
- Read: `sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/service/TelemetryService.java:25-170`

**Steps:**

- [ ] **Step 1: Identify current timestamp format constants (lines 28-29)**
  ```java
  private static final String TIMESTAMP_FORMAT = "yyyyMMddHHmmssSSS";
  private static final DateTimeFormatter FORMATTER = DateTimeFormatter.ofPattern(TIMESTAMP_FORMAT).withZone(java.time.ZoneOffset.UTC);
  ```

- [ ] **Step 2: Identify ROW_KEY_PATTERN (line 30)**
  ```java
  private static final Pattern ROW_KEY_PATTERN = Pattern.compile("^(.+)#(.+)$");
  ```

- [ ] **Step 3: Note parseRow uses Instant.parse() (line 181) — this WORKS for RFC3339Nano**

- [ ] **Step 4: Note buildRowKey uses FORMATTER (line 166) — this is WRONG format**

- [ ] **Step 5: Note queryTelemetry uses buildRowKey for bounds (lines 105-106) — bounds wrong**

- [ ] **Step 6: Note getLatestTelemetry uses `vehicleId + "#"` to `vehicleId + "~"` (lines 137-138) — this WORKS for prefix scan**

#### Task 2.2: Fix TelemetryService Timestamp Format

**Files:**
- Modify: `sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/service/TelemetryService.java:25-170`

**Interfaces:**
- Produces: `buildRowKey()` now returns RFC3339Nano format matching Go connector
- `parseRow()` unchanged (already handles RFC3339Nano via `Instant.parse()`)
- `queryTelemetry()` bounds now match stored keys
- `getLatestTelemetry()` range end key improved

**Steps:**

- [ ] **Step 1: Replace timestamp format constants (lines 28-30)**
  ```java
  // REPLACE lines 28-30:
  private static final String BIGTABLE_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSSSSX"; // RFC3339Nano
  private static final DateTimeFormatter BIGTABLE_FORMATTER = 
      DateTimeFormatter.ofPattern(BIGTABLE_TIMESTAMP_FORMAT).withZone(ZoneOffset.UTC);
  private static final Pattern ROW_KEY_PATTERN = Pattern.compile("^(.+)#(.+)$");
  ```

- [ ] **Step 2: Update buildRowKey method (lines 165-168)**
  ```java
  // REPLACE lines 165-168:
  private String buildRowKey(String vehicleId, Instant timestamp) {
      String ts = BIGTABLE_FORMATTER.format(timestamp);
      return vehicleId + "#" + ts;
  }
  ```

- [ ] **Step 3: Improve getLatestTelemetry end key (lines 137-140)**
  ```java
  // REPLACE lines 137-140:
  String startKey = vehicleId + "#";
  String endKey = vehicleId + "0"; // Lexicographically after all timestamps for this VIN
  RowRange rowRange = RowRange.of(startKey, true, endKey, false);
  ```

- [ ] **Step 4: Verify parseRow unchanged (lines 173-185) — already correct**
  ```java
  // parseRow uses Instant.parse(tsStr) which handles RFC3339Nano ✓
  ```

- [ ] **Step 5: Add column family constants (optional, after line 30)**
  ```java
  private static final String DYNAMIC_FAMILY = "dynamic";
  private static final String STATIC_FAMILY = "static";
  ```

#### Task 2.3: Add Protobuf Maven Plugin for Shared Proto

**Files:**
- Modify: `sample-services/telemetry-chart-service/pom.xml`

**Steps:**

- [ ] **Step 1: Add protobuf-maven-plugin to build/plugins section**
  ```xml
  <plugin>
      <groupId>org.xolstice.maven.plugins</groupId>
      <artifactId>protobuf-maven-plugin</artifactId>
      <version>0.6.1</version>
      <configuration>
          <protocArtifact>com.google.protobuf:protoc:3.25.1:exe:${os.detected.classifier}</protocArtifact>
          <pluginId>grpc-java</pluginId>
          <pluginArtifact>io.grpc:protoc-gen-grpc-java:1.62.1:exe:${os.detected.classifier}</pluginArtifact>
          <protoSourceRoot>${project.basedir}/../../../base-services/nats-bigtable-connector/proto</protoSourceRoot>
          <includes>
              <include>telemetry.proto</include>
          </includes>
      </configuration>
      <executions>
          <execution>
              <goals>
                  <goal>compile</goal>
                  <goal>compile-custom</goal>
              </goals>
          </execution>
      </executions>
  </plugin>
  ```

- [ ] **Step 2: Add protobuf-java dependency**
  ```xml
  <dependency>
      <groupId>com.google.protobuf</groupId>
      <artifactId>protobuf-java</artifactId>
      <version>3.25.1</version>
  </dependency>
  ```

- [ ] **Step 3: Add grpc dependencies if not present**
  ```xml
  <dependency>
      <groupId>io.grpc</groupId>
      <artifactId>grpc-stub</artifactId>
      <version>1.62.1</version>
  </dependency>
  <dependency>
      <groupId>io.grpc</groupId>
      <artifactId>grpc-protobuf</artifactId>
      <version>1.62.1</version>
  </dependency>
  ```

#### Task 2.4: Update Java Unit Tests

**Files:**
- Modify: `sample-services/telemetry-chart-service/src/test/java/.../TelemetryServiceTest.java` (create if missing)

**Steps:**

- [ ] **Step 1: Create/verify test for buildRowKey format**
  ```java
  @Test
  void buildRowKey_usesRFC3339NanoFormat() {
      Instant ts = Instant.parse("2026-07-18T15:04:05.123456789Z");
      String rowKey = telemetryService.buildRowKey("VIN123", ts);
      // Should match Go connector format
      assertEquals("VIN123#2026-07-18T15:04:05.123456789Z", rowKey);
  }
  ```

- [ ] **Step 2: Create test for parseRow with RFC3339Nano**
  ```java
  @Test
  void parseRow_parsesRFC3339NanoTimestamp() {
      // Create mock Row with key VIN123#2026-07-18T15:04:05.123456789Z
      // Verify returned TelemetryPoint has correct Instant
  }
  ```

- [ ] **Step 3: Create test for queryTelemetry bounds**
  ```java
  @Test
  void queryTelemetry_boundsMatchStoredKeys() {
      // Verify startKey/endKey built from Instants match Go connector row keys
  }
  ```

#### Task 2.5: Build and Test Java Service

**Files:**
- Run: `sample-services/telemetry-chart-service/pom.xml`

**Steps:**

- [ ] **Step 1: Compile with protobuf generation**
  ```bash
  cd sample-services/telemetry-chart-service
  mvn clean compile
  # Should generate protobuf classes in target/generated-sources/protobuf/
  ```

- [ ] **Step 2: Run unit tests**
  ```bash
  mvn test
  # All tests should pass
  ```

- [ ] **Step 3: Build Docker image for local stack**
  ```bash
  cd local-dev
  docker compose build telemetry-chart-service
  ```

#### Task 2.6: Deploy Fixed Java Service & Verify Read Path

**Files:**
- Run: `local-dev/docker-compose.yml` (telemetry-chart-service)

**Steps:**

- [ ] **Step 1: Restart Java service with fix**
  ```bash
  cd local-dev
  docker compose up -d telemetry-chart-service
  # Wait for startup (~15s)
  ```

- [ ] **Step 2: Test REST endpoint with data from Phase 1**
  ```bash
  # Query telemetry written by Go connector
  curl "http://localhost:8081/api/v1/vehicles/VIN123/telemetry?columns=dynamic:temp"
  # Should return JSON array with timestamp and values
  ```

- [ ] **Step 3: Test latest telemetry endpoint**
  ```bash
  curl "http://localhost:8081/api/v1/vehicles/VIN123/telemetry/latest?columns=dynamic:temp"
  # Should return single most recent point
  ```

- [ ] **Step 4: Test WebSocket endpoint**
  ```bash
  # Connect to ws://localhost:8081/ws/telemetry?vin=VIN123&columns=dynamic:temp
  # Send: {"type":"subscribe","columns":["dynamic:temp"]}
  # Should receive periodic updates
  ```

**Acceptance Criteria (Phase 2):**
- [ ] `TelemetryService.queryTelemetry(vin, start, end, columns)` returns rows written by Go connector
- [ ] `getLatestTelemetry(vin)` returns most recent row
- [ ] WebSocket `/ws/telemetry?vin=VIN123&columns=dynamic:temp` pushes updates (polling-based)
- [ ] `mvn test -pl telemetry-chart-service` passes

**Rollback Phase 2:**
```bash
cd sample-services/telemetry-chart-service
git checkout src/main/java/com/nexus/sdv/telemetrychartservice/service/TelemetryService.java
git checkout pom.xml
mvn clean compile
cd local-dev
docker compose build telemetry-chart-service
docker compose up -d telemetry-chart-service
```

---

### Phase 3: Frontend Integration Verification

#### Task 3.1: Start Full Stack with Fixed Services

**Files:**
- Run: `local-dev/Makefile`, `local-dev/go.sh`

**Steps:**

- [ ] **Step 1: Stop any running stack**
  ```bash
  cd local-dev
  make stop
  ```

- [ ] **Step 2: Start full stack (includes frontend)**
  ```bash
  make go
  # This starts: infra, base-services, sample-services, and data-web-client (frontend on :3000)
  ```

- [ ] **Step 3: Verify all services healthy**
  ```bash
  make status
  # All services should show "running"
  ```

- [ ] **Step 4: Verify frontend accessible**
  ```bash
  curl -s http://localhost:3000 | head -5
  # Should return HTML
  ```

#### Task 3.2: Seed Test Data in Bigtable

**Files:**
- Run: `local-dev/scripts/ingest-sample.sh`

**Steps:**

- [ ] **Step 1: Ingest sample data for VIN123**
  ```bash
  make ingest
  # Writes rows with RFC3339Nano timestamps
  ```

- [ ] **Step 2: Verify data in Bigtable**
  ```bash
  make query
  # Should show VIN123 rows with dynamic:temp, dynamic:speed, etc.
  ```

#### Task 3.3: Verify Frontend Device Page Loads

**Files:**
- Read: `sample-clients/data-web-client/src/app/device/[id]/page.tsx`

**Steps:**

- [ ] **Step 1: Open device page in browser**
  ```
  http://localhost:3000/device/VIN123
  ```

- [ ] **Step 2: Verify page loads without errors**
  - No console errors in DevTools (F12)
  - Device header shows "VIN123"
  - Telemetry chart component renders

- [ ] **Step 3: Verify historical data loads**
  - Chart should display lines for sensors (speed, battery.soc, battery.temp)
  - Time range selector defaults to "1h"
  - Data table shows rows with timestamps

#### Task 3.4: Verify Live Chart Updates via MQTT

**Files:**
- Run: `mosquitto_pub` (host), WebSocket connection from frontend

**Steps:**

- [ ] **Step 1: Open browser DevTools Network tab, filter WS**
  - Confirm WebSocket connection to `ws://localhost:8081/ws/telemetry?vin=VIN123&columns=...`

- [ ] **Step 2: Publish new MQTT message**
  ```bash
  mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/speed" \
    -m '{"name":"speed","value":72.5,"unit":"km/h"}'
  ```

- [ ] **Step 3: Observe chart update**
  - Within ~2 seconds: new data point appears on "speed" line
  - Value should be 72.5
  - No page refresh needed

- [ ] **Step 4: Test multiple sensors**
  ```bash
  mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/temp" \
    -m '{"name":"temp","value":28.0,"unit":"C"}'
  mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/battery.soc" \
    -m '{"name":"battery.soc","value":90.0,"unit":"%"}'
  ```
  - Each sensor appears as separate line on chart

#### Task 3.5: Verify REST API Proxy Works

**Files:**
- Read: `sample-clients/data-web-client/src/app/api/telemetry/[vin]/route.ts`

**Steps:**

- [ ] **Step 1: Test Next.js API proxy**
  ```bash
  curl "http://localhost:3000/api/telemetry/VIN123?columns=dynamic:temp,dynamic:speed"
  # Should proxy to Java service and return JSON
  ```

- [ ] **Step 2: Verify frontend fetches via proxy**
  - Network tab shows request to `/api/telemetry/VIN123?...`
  - Response contains telemetry points

#### Task 3.6: Run Frontend Tests

**Files:**
- Run: `sample-clients/data-web-client/package.json`

**Steps:**

- [ ] **Step 1: Install dependencies if needed**
  ```bash
  cd sample-clients/data-web-client
  npm ci
  ```

- [ ] **Step 2: Run tests**
  ```bash
  npm test
  # All component tests pass
  ```

**Acceptance Criteria (Phase 3):**
- [ ] Frontend at `localhost:3000` loads device page
- [ ] Chart displays historical data from Bigtable (last hour by default)
- [ ] New MQTT publishes appear on chart within ~2s (polling interval)
- [ ] Multiple sensors/columns render as separate lines
- [ ] No console errors in browser DevTools
- [ ] `npm test` in data-web-client passes

**Rollback Phase 3:**
```bash
cd local-dev
make stop
make clean
make go
# Reverts to clean state
```

---

## Complete End-to-End Verification

### Final Smoke Test

```bash
cd local-dev

# 1. Full stack running
make go

# 2. All integration tests pass
make test
# ✅ Test 1: All services running
# ✅ Test 2: Infrastructure endpoints reachable
# ✅ Test 3: Bigtable table exists
# ✅ Test 4: MQTT → Bigtable ingestion works

# 3. Manual E2E: Publish → Chart updates
mosquitto_pub -h localhost -t "telemetry/VIN123/sensors/speed" \
  -m '{"name":"speed","value":72.5,"unit":"km/h"}'
# → Open http://localhost:3000/device/VIN123
# → Chart shows new speed point within 2s

# 4. Java unit tests pass
cd ../sample-services/telemetry-chart-service
mvn test

# 5. Frontend tests pass
cd ../../sample-clients/data-web-client
npm test
```

---

## File Modification Summary

| Phase | File | Change Type |
|-------|------|-------------|
| 1 | `base-services/nats-bigtable-connector/src/main.go` | Fixes (if any needed) |
| 1 | `local-dev/config/data-converter.yaml` | Topic alignment (if needed) |
| 2 | `sample-services/telemetry-chart-service/src/main/java/.../service/TelemetryService.java` | Timestamp format fixes |
| 2 | `sample-services/telemetry-chart-service/pom.xml` | Add protobuf-maven-plugin |
| 2 | `sample-services/telemetry-chart-service/src/test/.../TelemetryServiceTest.java` | Unit tests |
| 3 | `sample-clients/data-web-client/` | Verify only (no changes expected) |

---

## Time Estimates

| Phase | Task | Estimate |
|-------|------|----------|
| 1 | Run stack + baseline test | 15 min |
| 1 | Verify topic mapping | 5 min |
| 1 | Verify protobuf alignment | 10 min |
| 1 | Fix Go connector issues | 15-30 min |
| 1 | Verify Bigtable connectivity | 5 min |
| 1 | Re-test & confirm | 10 min |
| **Phase 1 Total** | | **~60-90 min** |
| 2 | Examine TelemetryService | 10 min |
| 2 | Fix timestamp format constants & buildRowKey | 15 min |
| 2 | Improve getLatestTelemetry range | 5 min |
| 2 | Add protobuf Maven plugin | 15 min |
| 2 | Write/update unit tests | 20 min |
| 2 | Build & test Java service | 15 min |
| 2 | Deploy & verify read path | 15 min |
| **Phase 2 Total** | | **~95 min** |
| 3 | Start full stack | 15 min |
| 3 | Seed test data | 5 min |
| 3 | Verify frontend loads | 10 min |
| 3 | Verify live MQTT → chart updates | 15 min |
| 3 | Verify REST proxy | 5 min |
| 3 | Run frontend tests | 10 min |
| **Phase 3 Total** | | **~60 min** |
| **Grand Total** | | **~3.5-4 hours** |

---

## Self-Review Checklist

- [ ] Spec coverage: All 3 phases from design spec mapped to tasks
- [ ] Phase 1: Test 4 verification, Go connector fixes, protobuf alignment
- [ ] Phase 2: TelemetryService row key format fix, protobuf plugin, unit tests, read path verification
- [ ] Phase 3: Full stack startup, frontend verification, live updates, test suite
- [ ] No placeholders: Every step has exact commands, code, expected output
- [ ] Type consistency: Java `Instant` ↔ `DateTimeFormatter` patterns match Go `time.Format`
- [ ] Rollback procedures provided for each phase
- [ ] Time estimates realistic for experienced engineer

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-18-nats-bigtable-ingestion-verification-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review

**Which approach?**
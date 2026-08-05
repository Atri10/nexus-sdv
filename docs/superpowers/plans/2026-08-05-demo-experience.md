# Interactive Demo Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-command demo — randomized vehicles controlled from an animated `/demo` page that shows which vehicle component produces what data and where it flows.

**Architecture:** NATS-controlled simulator compose service (control subject `commands.<VIN>.demo`), Keycloak VIN pool (VIN1001–VIN1010), connector persists dynamics, web `/demo` page with SVG schematic + animated data path + live chart, `make demo` launcher.

**Tech Stack:** Go (vehicle-client + connector), bash (entrypoint, setup), Python3 (realm pool generator), Next.js 16 + bun + Tailwind v4 + shadcn + Chart.js (web), docker-compose, Keycloak realm JSON.

## Global Constraints

- Branch: `feat/local-dev-no-gcp` only. Never touch `main`/`origin/main`.
- Auth model preserved: per-VIN Keycloak clients; auth-callout code untouched. Simulator receives commands via its own `edge-device` JWT grant (`commands.<VIN>.>`); the web side publishes via the connector account (nats.conf gets `commands.>` publish).
- Connector/Bigtable qualifier names are the contract for the demo component metadata: `dynamic:battery.*` (TelemetryMessage sensors), `dynamic:ENGINE_POWER|ENGINE_RPM|FUEL_CAPACITY|FUEL_LEVEL|TIRE_PRESSURE|VELOCITY|GPS_LATITUDE|GPS_LONGITUDE` + new `dynamic:STEERING_ANGLE_DEG|ACCELERATOR_PEDAL_PCT|BRAKE_PEDAL_PCT`; `static:*` via DataType_STATIC readings.
- The host wrapper path (`make vehicle-client`, no control subject) must keep working unchanged.
- Web: bun only; no new npm dependencies (animations are CSS/SVG). Tests via `bun test`.
- Go: `go build ./...` green per module; new tests use std `testing`.
- `make test` (smoke, VIN123) must stay green — VIN123 remains in the realm.
- Commit per task, conventional messages.

---

### Task 1: Realm VIN pool (VIN1001–VIN1010)

**Files:**
- Create: `local-dev/scripts/generate-vin-pool.py`
- Modify: `local-dev/keycloak/nexus-realm.json`

**Interfaces:**
- Produces: 10 clients (secrets `vin10XX-secret`, serviceAccountsEnabled, realm-roles mapper, same shape as VIN123) + 10 users `service-account-vin10XX` with `realmRoles: ["edge-device","telemetry-client"]`. Consumed by Task 5 (random VIN), Task 6 (env), Task 8 (vehicle list).

- [ ] **Step 1: Write the generator script**

`local-dev/scripts/generate-vin-pool.py` — deterministic, prints two JSON fragments (clients array items + users array items), no dependencies:

```python
#!/usr/bin/env python3
"""Generate the per-VIN Keycloak client pool for local-dev.

Prints two JSON fragments to stdout:
  --clients   one client object per VIN (VIN1001..VIN1010)
  --users     one service-account user object per VIN
The realm import (keycloak/nexus-realm.json) embeds these; re-run and paste
whenever the pool changes. Deterministic output (fixed order, no randomness).
"""
import sys

POOL_SIZE = 10
PREFIX = "VIN10"


def client(vin: str, idx: int) -> str:
    secret = f"{vin.lower()}-secret"
    return f"""    {{
      "clientId": "{vin}",
      "name": "Vehicle Client {vin}",
      "description": "Per-VIN confidential client; azp={vin} so auth-callout grants telemetry.{vin}.> and commands.{vin}.>",
      "rootUrl": "",
      "adminUrl": "",
      "baseUrl": "",
      "surrogateAuthRequired": false,
      "enabled": true,
      "alwaysDisplayInConsole": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "{secret}",
      "redirectUris": ["*"],
      "webOrigins": ["*"],
      "notBefore": 0,
      "bearerOnly": false,
      "consentRequired": false,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "publicClient": false,
      "frontchannelLogout": false,
      "protocol": "openid-connect",
      "attributes": {{
        "oauth2.device.authorization.grant.enabled": "false",
        "oidc.ciba.grant.enabled": "false",
        "client.secret.creation.time": "0"
      }},
      "authenticationFlowBindingOverrides": {{}},
      "fullScopeAllowed": true,
      "nodeReRegistrationTimeout": -1,
      "protocolMappers": [
        {{
          "name": "realm roles",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "consentRequired": false,
          "config": {{
            "multivalued": "true",
            "userinfo.token.claim": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "realm_access.roles",
            "jsonType.label": "String"
          }}
        }}
      ]
    }}"""


def user(vin: str) -> str:
    return f"""    {{
      "username": "service-account-{vin.lower()}",
      "enabled": true,
      "emailVerified": false,
      "serviceAccountClientId": "{vin}",
      "realmRoles": ["edge-device", "telemetry-client"]
    }}"""


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    vins = [f"{PREFIX}{i:02d}" for i in range(1, POOL_SIZE + 1)]
    if mode == "--clients":
        print(",\n".join(client(v, i) for i, v in enumerate(vins)))
    elif mode == "--users":
        print(",\n".join(user(v) for v in vins))
    else:
        print("usage: generate-vin-pool.py --clients|--users", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Apply to the realm**

```bash
cd local-dev
python3 scripts/generate-vin-pool.py --clients > /tmp/pool-clients.txt
python3 scripts/generate-vin-pool.py --users > /tmp/pool-users.txt
```
Insert the clients fragment into `keycloak/nexus-realm.json` inside `"clients": [ … ]` (after the `VIN123` client, comma-separated), and the users fragment into `"users": [ … ]` (after `service-account-vin123`). Keep JSON valid — verify with jq.

- [ ] **Step 3: Verify**

```bash
jq -e '.clients | map(select(.clientId | startswith("VIN10"))) | length == 10' local-dev/keycloak/nexus-realm.json
jq -e '.users | map(select(.username | startswith("service-account-vin10"))) | length == 10' local-dev/keycloak/nexus-realm.json
jq -e '.clients[] | select(.clientId=="VIN1001") | .secret == "vin1001-secret" and .serviceAccountsEnabled' local-dev/keycloak/nexus-realm.json
```
Expected: `true` ×3, exit 0.

- [ ] **Step 4: Commit**

```bash
git add local-dev/scripts/generate-vin-pool.py local-dev/keycloak/nexus-realm.json
git commit -m "feat(local-dev): add Keycloak VIN pool VIN1001-VIN1010 with generator script"
```

---

### Task 2: Connector persists vehicle dynamics (STEERING/ACCELERATOR/BRAKE)

**Files:**
- Modify: `base-services/nats-bigtable-connector/src/main.go` (MetricsReport branch, after the `GPS_LONGITUDE` block ~line 160)

**Interfaces:**
- Produces: `dynamic:STEERING_ANGLE_DEG`, `dynamic:ACCELERATOR_PEDAL_PCT`, `dynamic:BRAKE_PEDAL_PCT` rows (when `VehicleDynamics` non-nil). Consumed by Task 8's component metadata.

- [ ] **Step 1: Add dynamics persistence**

Insert after the GPS_LONGITUDE block (before `if err := tbl.Apply(...)`):

```go
		if vtd.VehicleDynamics != nil {
			addMetric("STEERING_ANGLE_DEG", vtd.VehicleDynamics.SteeringAngleDeg)
			addMetric("ACCELERATOR_PEDAL_PCT", vtd.VehicleDynamics.AcceleratorPedalPct)
			addMetric("BRAKE_PEDAL_PCT", vtd.VehicleDynamics.BrakePedalPct)
		}
```

- [ ] **Step 2: Verify**

Run: `cd base-services/nats-bigtable-connector && go build ./...`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add base-services/nats-bigtable-connector/src/main.go
git commit -m "feat(connector): persist vehicle dynamics (steering, accelerator, brake)"
```

---

### Task 3: NATS control perms + web container NATS env

**Files:**
- Modify: `local-dev/setup-automated.sh` (nats.conf generation, connector user perms)
- Modify: `local-dev/docker-compose.yml` (data-web-client environment)

**Interfaces:**
- Produces: connector account can publish `commands.>` (the web control route uses it); web container gets `NATS_URL`, `NATS_SCORING_USER`, `NATS_SCORING_PASSWORD`. Consumed by Task 7.

- [ ] **Step 1: nats.conf connector perms**

In `setup-automated.sh` `phase_nats_config`, the generated `nats.conf` has:

```conf
    users: [
        {user: "connector", password: "connector-pass", permissions: {subscribe: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>"], publish: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>"]}}
    ]
```

Replace both the subscribe and publish arrays with:

```conf
        {user: "connector", password: "connector-pass", permissions: {subscribe: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>", "commands.>"], publish: ["telemetry.>", "telemetry-generic.>", "local.telemetry.>", "scoring.>", "commands.>"]}}
```

- [ ] **Step 2: Web container NATS env**

In `local-dev/docker-compose.yml`, the `data-web-client` environment block — add:

```yaml
      - NATS_URL=nats://nats:4222
      - NATS_SCORING_USER=connector
      - NATS_SCORING_PASSWORD=connector-pass
```

- [ ] **Step 3: Verify**

```bash
bash -n local-dev/setup-automated.sh
grep -n 'commands.>' local-dev/setup-automated.sh
docker compose -f local-dev/docker-compose.yml config --quiet 2>/dev/null || echo "compose config: daemon/network check skipped"
```
Expected: bash -n exit 0; grep shows the perms line; compose config exit 0 (or the noted skip).

- [ ] **Step 4: Commit**

```bash
git add local-dev/setup-automated.sh local-dev/docker-compose.yml
git commit -m "feat(local-dev): allow connector NATS account to publish commands.>; wire web container NATS env"
```

---

### Task 4: vehicle-client — drive cycle, GPS walk, static sensors, both message types

**Files:**
- Modify: `sample-clients/vehicle-client/main.go`
- Create: `sample-clients/vehicle-client/sim_test.go`

**Interfaces:**
- Produces: pure helpers `randomVinFromPool(pool []string) string`, `newDriveState()`, `driveCycleStep(s *driveState, dtSeconds float64)`, `gpsWalk(lat, lng float64) (float64, float64)`, `clamp(v, lo, hi float64) float64`; `-message-type` accepts `both`; `-vin ""` picks a random pool VIN from `VIN_POOL` env. Consumed by Task 5 (control loop) and Task 6 (entrypoint).

- [ ] **Step 1: Write the failing tests**

Create `sample-clients/vehicle-client/sim_test.go`:

```go
package main

import (
	"strings"
	"testing"
)

func TestClamp(t *testing.T) {
	if got := clamp(150, 0, 100); got != 100 {
		t.Fatalf("clamp(150,0,100) = %v, want 100", got)
	}
	if got := clamp(-5, 0, 100); got != 0 {
		t.Fatalf("clamp(-5,0,100) = %v, want 0", got)
	}
	if got := clamp(42, 0, 100); got != 42 {
		t.Fatalf("clamp(42,0,100) = %v, want 42", got)
	}
}

func TestRandomVinFromPool(t *testing.T) {
	pool := []string{"VIN1001", "VIN1002", "VIN1003"}
	seen := map[string]bool{}
	for i := 0; i < 60; i++ {
		v := randomVinFromPool(pool)
		if !contains(pool, v) {
			t.Fatalf("randomVinFromPool returned %q, not in pool", v)
		}
		seen[v] = true
	}
	if len(seen) < 2 {
		t.Fatalf("randomVinFromPool not random: only saw %v", seen)
	}
}

func TestDriveCycleBounds(t *testing.T) {
	s := newDriveState()
	for i := 0; i < 2000; i++ {
		driveCycleStep(&s, 1.0)
		if s.velocity < 0 || s.velocity > 200 {
			t.Fatalf("velocity out of bounds: %v", s.velocity)
		}
		if s.acceleratorPct < 0 || s.acceleratorPct > 100 {
			t.Fatalf("accelerator out of bounds: %v", s.acceleratorPct)
		}
		if s.brakePct < 0 || s.brakePct > 100 {
			t.Fatalf("brake out of bounds: %v", s.brakePct)
		}
		if s.engineRPM < 0 || s.engineRPM > 6000 {
			t.Fatalf("rpm out of bounds: %v", s.engineRPM)
		}
	}
}

func TestGpsWalkBounds(t *testing.T) {
	lat, lng := 12.9716, 77.5946
	for i := 0; i < 1000; i++ {
		lat, lng = gpsWalk(lat, lng)
		if lat < 12.9 || lat > 13.05 || lng < 77.5 || lng > 77.7 {
			t.Fatalf("gps out of bounds: %v, %v", lat, lng)
		}
	}
}

func TestDriveCycleProfileVariety(t *testing.T) {
	s := newDriveState()
	velocities := map[float64]bool{}
	for i := 0; i < 3000; i++ {
		driveCycleStep(&s, 1.0)
		velocities[s.velocity] = true
	}
	if len(velocities) < 10 {
		t.Fatalf("drive cycle too static: %d distinct velocities", len(velocities))
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestPoolEnvParsing(t *testing.T) {
	pool := parseVINPool("VIN1001,VIN1002 VIN1003")
	if len(pool) != 3 || !strings.HasPrefix(pool[0], "VIN10") {
		t.Fatalf("parseVINPool = %v", pool)
	}
}
```

- [ ] **Step 2: Run tests — verify they FAIL**

Run: `cd sample-clients/vehicle-client && go test ./...`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the simulator state + helpers**

Add to `main.go` (new file section, before `main`):

```go
// --- Randomized drive simulation -------------------------------------------

type driveState struct {
	velocity      float64
	engineRPM     float64
	enginePower   float64
	fuelLevel     float64
	steeringAngle float64
	acceleratorPct float64
	brakePct      float64
	phase         int    // 0 accelerate, 1 cruise, 2 brake, 3 idle
	phaseLeft     float64 // seconds remaining in current phase
	baseLat       float64
	baseLng       float64
	lat           float64
	lng           float64
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func parseVINPool(raw string) []string {
	var pool []string
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		if part != "" {
			pool = append(pool, part)
		}
	}
	return pool
}

func randomVinFromPool(pool []string) string {
	if len(pool) == 0 {
		return "VIN1001"
	}
	return pool[mathrand.Intn(len(pool))]
}

func newDriveState() driveState {
	return driveState{
		fuelLevel:      20 + mathrand.Float64()*60,
		phase:          0,
		phaseLeft:      5 + mathrand.Float64()*10,
		baseLat:        12.9716 + (mathrand.Float64()-0.5)*0.02,
		baseLng:        77.5946 + (mathrand.Float64()-0.5)*0.02,
		lat:            12.9716,
		lng:            77.5946,
		steeringAngle:  (mathrand.Float64() - 0.5) * 4,
	}
}

// driveCycleStep advances the drive profile by dt seconds. Velocity follows a
// smooth accelerate/cruise/brake/idle cycle; derived sensors correlate.
func driveCycleStep(s *driveState, dt float64) {
	s.phaseLeft -= dt
	if s.phaseLeft <= 0 {
		s.phase = (s.phase + 1) % 4
		switch s.phase {
		case 0:
			s.phaseLeft = 6 + mathrand.Float64()*12 // accelerate
		case 1:
			s.phaseLeft = 8 + mathrand.Float64()*15 // cruise
		case 2:
			s.phaseLeft = 4 + mathrand.Float64()*8 // brake
		case 3:
			s.phaseLeft = 3 + mathrand.Float64()*6 // idle
		}
	}

	switch s.phase {
	case 0: // accelerate
		s.velocity += 1.5 * dt
		s.acceleratorPct = clamp(40+mathrand.Float64()*40, 0, 100)
		s.brakePct = 0
	case 1: // cruise
		s.velocity += (mathrand.Float64() - 0.5) * 0.6 * dt
		s.acceleratorPct = clamp(15+mathrand.Float64()*20, 0, 100)
		s.brakePct = 0
	case 2: // brake
		s.velocity -= 3.0 * dt
		s.acceleratorPct = 0
		s.brakePct = clamp(20+mathrand.Float64()*40, 0, 100)
	case 3: // idle
		s.velocity -= 0.5 * dt
		s.acceleratorPct = 0
		s.brakePct = clamp(0, 0, 100)
	}
	s.velocity = clamp(s.velocity, 0, 200)
	s.brakePct = clamp(s.brakePct, 0, 100)

	// Derived engine state.
	targetRPM := 800 + s.velocity*35 + s.acceleratorPct*8
	s.engineRPM = clamp(targetRPM+(mathrand.Float64()-0.5)*150, 0, 6000)
	s.enginePower = clamp(s.velocity*0.35+s.acceleratorPct*0.8+(mathrand.Float64()-0.5)*5, 0, 150)
	s.fuelLevel -= dt * 0.002 * (0.5 + s.engineRPM/4000)
	if s.fuelLevel < 5 {
		s.fuelLevel = 60
	}
	s.steeringAngle = clamp(s.steeringAngle+(mathrand.Float64()-0.5)*0.8, -45, 45)

	// GPS random walk around the base position.
	s.lat, s.lng = gpsWalk(s.baseLat, s.baseLng)
}

// gpsWalk returns a position within ~0.01deg of base (roughly 1km).
func gpsWalk(baseLat, baseLng float64) (float64, float64) {
	lat := clamp(baseLat+(mathrand.Float64()-0.5)*0.008, baseLat-0.012, baseLat+0.012)
	lng := clamp(baseLng+(mathrand.Float64()-0.5)*0.008, baseLng-0.012, baseLng+0.012)
	return lat, lng
}
```

Add `"strings"` to the imports if not present.

- [ ] **Step 4: Random VIN default from pool**

In `main`, replace:

```go
	vin := flag.String("vin", "1HGBH41JXMN109186", "Vehicle Identification Number")
```

with:

```go
	vin := flag.String("vin", "", "Vehicle Identification Number (empty = random from VIN_POOL env)")
```

After `flag.Parse()` and after the existing message-type validation, add:

```go
	// Random VIN selection when none given: pick from the pool env (set by the
	// local-dev simulator service / entrypoint) or fall back to a fixed VIN.
	vinPool := parseVINPool(os.Getenv("VIN_POOL"))
	if *vin == "" {
		*vin = randomVinFromPool(vinPool)
		log.Printf("Random VIN selected from pool: %s", *vin)
	}
```

- [ ] **Step 5: Both-message-types support**

Change the `-message-type` flag default to `"both"` and its doc string; in `PublishTelemetryContinuously`, replace the `if v.MessageType == "telemetry" { … } else if v.MessageType == "metrics_report" { … }` block with a helper `buildPayloads(now time.Time, battery batteryState, drive driveState, messageType string, count int) []publishMsg` (see below) and a loop that publishes each payload; `both` returns both the TelemetryMessage and MetricsReport payloads.

Add (pure, testable):

```go
type batteryState struct {
	voltage float64
	current float64
	soc     float64
	temp    float64
}

type publishMsg struct {
	subject string
	payload []byte
}

func buildBatteryTelemetry(vin string, b batteryState, now time.Time) (*pb.TelemetryMessage, error) { … existing battery message construction … }
func buildMetricsReport(vin string, drive driveState, now time.Time, count int) (*pbMetrics.MetricsReport, error) { … existing report construction with drive values + GPS … }
```

The battery random-walk block (voltage/current/soc/temp) stays, plus a static reading so the Cabin/static story has data: add to the TelemetryMessage `SensorData`:

```go
					{
						Timestamp: timestamppb.New(now),
						Value:     "Nexus SDV",
						DataType:  pb.DataType_STATIC,
						Sensor:    "make",
					},
					{
						Timestamp: timestamppb.New(now),
						Value:     fmt.Sprintf("%d", 2026),
						DataType:  pb.DataType_STATIC,
						Sensor:    "index",
					},
```

The MetricsReport uses `driveState` values: `ENGINE_POWER`, `ENGINE_RPM`, `FUEL_LEVEL`, `VELOCITY`, `GPS_LATITUDE`/`GPS_LONGITUDE` (now the walked values, non-zero), `TIRE_PRESSURE` (2.2 + small walk), `VehicleDynamics` with `SteeringAngleDeg`, `AcceleratorPedalPct`, `BrakePedalPct` (Task 2 persists these).

The ticker loop becomes: advance `batteryState` and `driveState` per tick, call `buildPayloads`, publish each with the existing `nc.Publish`.

- [ ] **Step 6: Run tests — verify GREEN**

Run: `cd sample-clients/vehicle-client && go build ./... && go test ./...`
Expected: BUILD + all tests pass.

- [ ] **Step 7: Commit**

```bash
git add sample-clients/vehicle-client/main.go sample-clients/vehicle-client/sim_test.go
git commit -m "feat(vehicle-client): randomized drive cycle, GPS walk, static sensors, both message types"
```

---

### Task 5: vehicle-client — NATS control mode

**Files:**
- Modify: `sample-clients/vehicle-client/main.go`

**Interfaces:**
- Consumes: Task 4 helpers/state.
- Produces: `-control-subject` flag (default empty = current behavior); when set, after the initial NATS connection, subscribe to the subject and handle `{"action":"start"|"stop"|"status"}` requests (reply JSON `{vin, running, published, messageType}`); `start` begins publishing, `stop` pauses, repeated commands idempotent. Control messages are plain JSON on the request's reply subject. Consumed by Task 6 (entrypoint flag) and Task 7 (web route).

- [ ] **Step 1: Control handler + state machine**

Add to `main.go`:

```go
type controlState struct {
	mu        sync.Mutex
	running   bool
	published int64
	startedAt time.Time
}

func (c *controlState) handle(msg *nats.Msg) {
	var req struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		c.reply(msg, map[string]any{"error": "invalid JSON"})
		return
	}
	c.mu.Lock()
	switch req.Action {
	case "start":
		if !c.running {
			c.running = true
			c.startedAt = time.Now()
		}
	case "stop":
		c.running = false
	case "status":
	default:
		c.mu.Unlock()
		c.reply(msg, map[string]any{"error": "unknown action"})
		return
	}
	state := map[string]any{
		"vin":         "",
		"running":     c.running,
		"published":   c.published,
		"messageType": "",
	}
	c.mu.Unlock()
	c.reply(msg, state)
}

func (c *controlState) reply(msg *nats.Msg, body map[string]any) {
	data, _ := json.Marshal(body)
	_ = msg.Respond(data)
}
```

(Set `vin`/`messageType` fields from the client when constructing the handler.)

Restructure `PublishTelemetryContinuously`: extract the ticker body into a method on a `simulator` struct with `start()`/`stop()` guarded by the same mutex; the loop becomes:

```go
	// Control loop: wait for start/stop over NATS when a control subject is
	// given; otherwise behave exactly as before (start publishing immediately).
	if v.controlSubject != "" {
		sub, err := nc.Subscribe(v.controlSubject, func(msg *nats.Msg) {
			ctl.handle(msg)
		})
		if err != nil {
			return fmt.Errorf("failed to subscribe to control subject: %w", err)
		}
		defer sub.Unsubscribe()
		log.Printf("Awaiting start command on %s", v.controlSubject)
		for range ticker.C {
			if ctl.running {
				publishOnce() // one tick while running
			}
			if time.Until(jwtExpiry) < refreshBuffer {
				refreshConnection() // keep JWT fresh while idle too
			}
		}
		return nil
	}
	for range ticker.C {
		publishOnce()
	}
```

Where `publishOnce()` contains the existing per-tick logic (advance state → build payloads → publish → `ctl.published++`). The flag wiring: `controlSubject := flag.String("control-subject", "", "NATS subject to listen for start/stop commands (empty = publish immediately)")`.

- [ ] **Step 2: Verify**

Run: `cd sample-clients/vehicle-client && go build ./... && go test ./...`
Expected: BUILD + tests pass.

- [ ] **Step 3: Commit**

```bash
git add sample-clients/vehicle-client/main.go
git commit -m "feat(vehicle-client): NATS control mode (start/stop/status on commands.<VIN>.demo)"
```

---

### Task 6: Simulator container (Dockerfile.local + entrypoint + compose service)

**Files:**
- Create: `sample-clients/vehicle-client/Dockerfile.local`, `sample-clients/vehicle-client/entrypoint.sh`
- Modify: `local-dev/docker-compose.yml` (vehicle-simulator service), `local-dev/configs/sample-services.template` (simulator env)

**Interfaces:**
- Consumes: Task 4 (`both` message types, random VIN), Task 5 (control mode).
- Produces: compose service `vehicle-simulator` — always up, idle until commanded; entrypoint mints a factory cert per VIN from the mounted factory CA, stages TLS certs, runs the binary with `-control-subject commands.$VIN.demo -message-type both`. Consumed by Task 9 (`make demo`) and Task 8 (buttons → control route).

- [ ] **Step 1: Dockerfile.local**

The service dir has no committed `proto/` (the host Makefile uses repo-root `../../proto`) and contains gitignored local junk (binary, certificates/) — so the build context is the **repo root** and COPYs are explicit:

```dockerfile
# Local-dev only build (see local-dev/docker-compose.yml). The GCP-deployed
# image is built from ./Dockerfile - do not edit that file for local-dev
# purposes, add changes here instead.
FROM golang:1.25-alpine AS builder

WORKDIR /app

RUN apk add --no-cache protobuf protobuf-dev \
    && go install google.golang.org/protobuf/cmd/protoc-gen-go@latest

COPY sample-clients/vehicle-client/go.mod sample-clients/vehicle-client/go.sum ./
RUN go mod download

COPY proto ./proto
# Explicit COPYs only — the service dir holds gitignored local artifacts
# (stale binary, certificates/) that must not enter the image.
COPY sample-clients/vehicle-client/main.go sample-clients/vehicle-client/sim_test.go ./

# Mirrors the host Makefile `proto` target exactly (no gRPC stubs needed —
# the client only uses message types).
RUN mkdir -p telemetry \
    && protoc --proto_path=./proto --proto_path=/usr/include \
       --go_out=telemetry --go_opt=paths=source_relative \
       ./proto/telemetry.proto ./proto/metrics_report.proto ./proto/vehicle_telemetry.proto \
    && CGO_ENABLED=0 go build -o /vehicle-client .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates openssl

COPY --from=builder /vehicle-client /vehicle-client
COPY sample-clients/vehicle-client/entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
```

Compose build block for the service (Task 6 Step 3) must use the repo-root context:

```yaml
    build:
      context: ../
      dockerfile: sample-clients/vehicle-client/Dockerfile.local
```

- [ ] **Step 2: entrypoint.sh**

```bash
#!/bin/sh
# Local-dev simulator entrypoint: mint a factory cert for the chosen VIN,
# stage the TLS certs the client reads unconditionally, then run in control
# mode. VIN_POOL is space/comma-separated; the binary picks a random member
# when -vin is empty.
set -eu

CERTS_DIR=/certs
WORK_DIR=/app
mkdir -p "$WORK_DIR/certificates"

# Stage server TLS certs the client reads unconditionally (PKI_STRATEGY=local
# ignores their contents for verification, but missing files are fatal).
cp "$CERTS_DIR/registration/server.crt.pem" "$WORK_DIR/certificates/REGISTRATION_SERVER_TLS_CERT.pem"
cp "$CERTS_DIR/keycloak/server.crt.pem"     "$WORK_DIR/certificates/KEYCLOAK_TLS_CRT.pem"

# Pick VIN (binary randomizes when VIN is empty) and mint a factory cert.
VIN="${VIN:-}"
if [ -z "$VIN" ]; then
    VIN=$(shuf -n 1 <<EOF
$(echo "$VIN_POOL" | tr ',' ' ')
EOF
)
fi
[ -n "$VIN" ] || VIN="VIN1001"

FACTORY_PREFIX="$WORK_DIR/certificates/factory-$VIN"
openssl req -newkey rsa:2048 -nodes \
    -keyout "$FACTORY_PREFIX-key.pem" \
    -out /tmp/factory.csr \
    -subj "/CN=VIN:$VIN DEVICE:simulator"
openssl x509 -req -in /tmp/factory.csr \
    -CA "$CERTS_DIR/registration/factory-ca.crt.pem" \
    -CAkey "$CERTS_DIR/registration/factory-ca.key.pem" \
    -CAcreateserial \
    -out "$FACTORY_PREFIX-chain.pem" -days 365 -sha256
rm -f /tmp/factory.csr

echo "Simulator: VIN=$VIN (control subject commands.$VIN.demo)"

exec /vehicle-client \
    -vin="$VIN" \
    -pki_strategy=local \
    -factory-cert="$FACTORY_PREFIX-chain.pem" \
    -factory-key="$FACTORY_PREFIX-key.pem" \
    -registration-url="${REGISTRATION_URL:-https://registration:8443}" \
    -message-type=both \
    -control-subject="commands.$VIN.demo" \
    -interval="${INTERVAL:-2}"
```

- [ ] **Step 3: Compose service + env template**

In `local-dev/docker-compose.yml` (after `data-web-client`), add:

```yaml
  vehicle-simulator:
    build:
      context: ../
      dockerfile: sample-clients/vehicle-client/Dockerfile.local
    container_name: nexus-vehicle-simulator
    environment:
      - VIN_POOL=${VIN_POOL}
      - INTERVAL=2
      - REGISTRATION_URL=https://registration:8443
      - KEYCLOAK_REALM=nexus-sdv
      - NATS_URL=nats://nats:4222
      - KEYCLOAK_URL=http://keycloak:8080
      - PKI_STRATEGY=local
    volumes:
      - ./certs:/certs:ro
    depends_on:
      - registration
      - keycloak
      - nats
      - nats-bigtable-connector
    networks:
      - nexus-local
```

Note: `VIN_POOL` comes from `.env.sample-services` — add to `local-dev/configs/sample-services.template`:

```
# vehicle-simulator (local-dev demo) — space/comma separated VIN pool
VIN_POOL=VIN1001 VIN1002 VIN1003 VIN1004 VIN1005 VIN1006 VIN1007 VIN1008 VIN1009 VIN1010
```

(The binary reads `KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` via env — the entrypoint does not set them, so the binary's `envOr("KEYCLOAK_CLIENT_ID", "car")` default would be wrong. **Fix**: set them in the compose env: `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET` cannot be static in compose (per-VIN). Instead, the entrypoint computes them after picking VIN and exports before exec:

```bash
export KEYCLOAK_CLIENT_ID="$VIN"
export KEYCLOAK_CLIENT_SECRET="$(echo "$VIN" | tr '[:upper:]' '[:lower:]')-secret"
```
add these lines to entrypoint.sh before `exec`.)

- [ ] **Step 4: Verify**

```bash
bash -n sample-clients/vehicle-client/entrypoint.sh
docker compose -f local-dev/docker-compose.yml config --quiet 2>/dev/null || echo "compose config skipped (daemon)"
```
Expected: exit 0 / noted skip.

- [ ] **Step 5: Commit**

```bash
git add sample-clients/vehicle-client/Dockerfile.local sample-clients/vehicle-client/entrypoint.sh local-dev/docker-compose.yml local-dev/configs/sample-services.template
git commit -m "feat(local-dev): vehicle-simulator compose service with NATS control mode"
```

---

### Task 7: Web control routes + demo lib

**Files:**
- Create: `sample-clients/data-web-client/src/lib/demo-control.ts`, `sample-clients/data-web-client/src/app/api/demo/vehicle/route.ts`, `sample-clients/data-web-client/src/app/api/demo/vehicles/route.ts`
- Test: `sample-clients/data-web-client/src/lib/demo-control.test.ts`

**Interfaces:**
- Consumes: Task 3 (connector `commands.>` perm + web NATS env).
- Produces: `demoControl(action, vin): Promise<DemoControlReply>` (NATS request/reply, 3s timeout, throws `DemoSimulatorOfflineError`); POST `/api/demo/vehicle` `{action, vin}` → 200 reply JSON / 400 bad action / 503 offline; GET `/api/demo/vehicles` → `{vehicles: string[]}` from chart service `GET /api/v1/vehicles`. Consumed by Task 8 (buttons, vehicle selector).

- [ ] **Step 1: demo-control lib (TDD)**

Write the failing test first (`demo-control.test.ts`): mock `@/lib/nats` `getNatsScoringConnection` with a fake `request()`; assert: request subject is `commands.VIN1001.demo`, payload parses, reply JSON returned; timeout throws `DemoSimulatorOfflineError`. Then implement:

```ts
import { getNatsScoringConnection } from '@/lib/nats';
import { StringCodec } from 'nats';

export type DemoAction = 'start' | 'stop' | 'status';

export interface DemoControlReply {
  vin: string;
  running: boolean;
  published: number;
  messageType: string;
  error?: string;
}

export class DemoSimulatorOfflineError extends Error {
  constructor() {
    super('Simulator did not respond — is the stack up and the simulator registered?');
    this.name = 'DemoSimulatorOfflineError';
  }
}

const sc = StringCodec();

export async function demoControl(action: DemoAction, vin: string): Promise<DemoControlReply> {
  const nc = await getNatsScoringConnection();
  let reply;
  try {
    // nats.js rejects on timeout (NatsTimeoutError) — map to a clear error.
    reply = await nc.request(
      `commands.${vin}.demo`,
      sc.encode(JSON.stringify({ action })),
      { timeout: 3000 }
    );
  } catch {
    throw new DemoSimulatorOfflineError();
  }
  return JSON.parse(sc.decode(reply.data)) as DemoControlReply;
}
```

- [ ] **Step 2: API routes**

`src/app/api/demo/vehicle/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { demoControl, type DemoAction } from '@/lib/demo-control';

export async function POST(request: Request) {
  let body: { action?: unknown; vin?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { action, vin } = body;
  if (
    typeof action !== 'string' ||
    !['start', 'stop', 'status'].includes(action) ||
    typeof vin !== 'string' ||
    !vin
  ) {
    return NextResponse.json({ error: 'expected { action: start|stop|status, vin: string }' }, { status: 400 });
  }
  try {
    const reply = await demoControl(action as DemoAction, vin);
    if (reply.error) return NextResponse.json(reply, { status: 400 });
    return NextResponse.json(reply);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'simulator offline' },
      { status: 503 }
    );
  }
}
```

`src/app/api/demo/vehicles/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CHART_SERVICE = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:8081';

export async function GET() {
  try {
    const res = await fetch(`${CHART_SERVICE}/api/v1/vehicles`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vehicles = (await res.json()) as string[];
    return NextResponse.json({ vehicles });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'chart service unreachable' },
      { status: 503 }
    );
  }
}
```

- [ ] **Step 3: Verify**

Run: `cd sample-clients/data-web-client && bun test src/lib/demo-control.test.ts && bun run test`
Expected: new tests pass; full suite green.

- [ ] **Step 4: Commit**

```bash
git add sample-clients/data-web-client/src/lib/demo-control.ts sample-clients/data-web-client/src/lib/demo-control.test.ts sample-clients/data-web-client/src/app/api/demo
git commit -m "feat(web): demo control API (NATS start/stop/status) + vehicle list route"
```

---

### Task 8: `/demo` page — schematic, data path, controls, graph

**Files:**
- Create: `sample-clients/data-web-client/src/lib/demo/vehicle-components.ts` (+ test), `src/components/demo/vehicle-schematic.tsx`, `src/components/demo/data-path.tsx`, `src/components/demo/demo-control-bar.tsx`, `src/app/demo/page.tsx`
- Modify: `src/app/globals.css` (flow-dash keyframes), `middleware.ts` (matcher), `src/components/sidebar.tsx` (Demo link)

**Interfaces:**
- Consumes: Task 7 routes; existing `useTelemetryData`, `TelemetryChart`, `LatestStats`, `TimeRangeSelector`, `ChartControls` patterns.
- Produces: `/demo` page. Component metadata keys MUST match connector qualifiers:
  - battery: `battery.voltage`, `battery.current`, `battery.soc`, `battery.temp`
  - powertrain: `ENGINE_POWER`, `ENGINE_RPM`, `FUEL_LEVEL`, `FUEL_CAPACITY`
  - chassis: `VELOCITY`, `GPS_LATITUDE`, `GPS_LONGITUDE`, `STEERING_ANGLE_DEG`, `ACCELERATOR_PEDAL_PCT`, `BRAKE_PEDAL_PCT`
  - cabin: `battery.temp` (dynamic) + `make`, `index` (static)
  Series keys are `{vin}|{column}` (column = full qualifier like `dynamic:battery.voltage`); the metadata stores the qualifier WITHOUT family and matches by suffix.

- [ ] **Step 1: Component metadata + helpers (TDD)**

`src/lib/demo/vehicle-components.ts`:

```ts
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export interface DemoComponent {
  id: string;
  label: string;
  description: string;
  sensors: { qualifier: string; label: string; unit?: string }[];
}

export const DEMO_COMPONENTS: DemoComponent[] = [
  {
    id: 'battery',
    label: 'Battery',
    description: 'High-voltage traction battery',
    sensors: [
      { qualifier: 'battery.voltage', label: 'Voltage', unit: 'V' },
      { qualifier: 'battery.current', label: 'Current', unit: 'A' },
      { qualifier: 'battery.soc', label: 'SoC', unit: '%' },
      { qualifier: 'battery.temp', label: 'Temp', unit: '°C' },
    ],
  },
  {
    id: 'powertrain',
    label: 'Powertrain',
    description: 'Electric drive unit',
    sensors: [
      { qualifier: 'ENGINE_POWER', label: 'Power', unit: 'kW' },
      { qualifier: 'ENGINE_RPM', label: 'RPM', unit: 'rpm' },
      { qualifier: 'FUEL_LEVEL', label: 'Fuel', unit: '%' },
      { qualifier: 'FUEL_CAPACITY', label: 'Fuel capacity', unit: 'L' },
    ],
  },
  {
    id: 'chassis',
    label: 'Chassis / GPS',
    description: 'Motion, position and driver input',
    sensors: [
      { qualifier: 'VELOCITY', label: 'Velocity', unit: 'km/h' },
      { qualifier: 'GPS_LATITUDE', label: 'Latitude' },
      { qualifier: 'GPS_LONGITUDE', label: 'Longitude' },
      { qualifier: 'STEERING_ANGLE_DEG', label: 'Steering', unit: '°' },
      { qualifier: 'ACCELERATOR_PEDAL_PCT', label: 'Accelerator', unit: '%' },
      { qualifier: 'BRAKE_PEDAL_PCT', label: 'Brake', unit: '%' },
    ],
  },
  {
    id: 'cabin',
    label: 'Cabin',
    description: 'Comfort and vehicle identity',
    sensors: [
      { qualifier: 'battery.temp', label: 'Battery temp', unit: '°C' },
      { qualifier: 'make', label: 'Make' },
      { qualifier: 'index', label: 'Model index' },
    ],
  },
];

/** Series whose column qualifier (after "family:") matches the component's sensor list. */
export function seriesForComponent(series: ChartSeries[], componentId: string): ChartSeries[] {
  const comp = DEMO_COMPONENTS.find((c) => c.id === componentId);
  if (!comp) return [];
  const qualifiers = new Set(comp.sensors.map((s) => s.qualifier));
  return series.filter((s) => {
    const colon = s.column.indexOf(':');
    const q = colon > -1 ? s.column.slice(colon + 1) : s.column;
    return qualifiers.has(q);
  });
}

export function latestValuesFor(series: ChartSeries[], componentId: string): Map<string, number | string> {
  const comp = DEMO_COMPONENTS.find((c) => c.id === componentId);
  if (!comp) return new Map();
  const out = new Map<string, number | string>();
  for (const sensor of comp.sensors) {
    const match = series.find((s) => {
      const colon = s.column.indexOf(':');
      return (colon > -1 ? s.column.slice(colon + 1) : s.column) === sensor.qualifier;
    });
    if (!match) continue;
    const last = [...match.points].reverse().find((p) => p.y != null);
    if (last?.y != null) out.set(sensor.qualifier, last.y);
  }
  return out;
}
```

Test (`vehicle-components.test.ts`): metadata qualifiers all present in the connector contract list; `seriesForComponent` filters correctly (incl. family prefix + compare VIN); `latestValuesFor` returns last value per sensor.

- [ ] **Step 2: CSS flow animation**

In `globals.css` add:

```css
/* Animated data-flow dashes on the /demo pipeline */
@keyframes flow-dash {
  to {
    stroke-dashoffset: -24;
  }
}

.flow-dash {
  stroke-dasharray: 8 4;
  animation: flow-dash 0.8s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .flow-dash {
    animation: none;
  }
}
```

- [ ] **Step 3: Schematic + data-path components**

`src/components/demo/vehicle-schematic.tsx` — an SVG car silhouette (simple rounded shapes) with 4 positioned, clickable `<g>` nodes; active component: fill highlight + `live-ping`-style pulse circle; `aria-pressed`/`role="button"` + keyboard handler. Sensor chips row under the schematic (per component): label, live value (mono), unit, colored by series color.

`src/components/demo/data-path.tsx` — SVG pipeline: 6 nodes (Component, NATS, Connector, Bigtable, Chart service, Graph) joined by a polyline path; when `flowing` is true the path gets the `flow-dash` class + node pulse on the active segment; `aria-hidden` decorations + a text fallback caption ("Telemetry flowing: VIN → NATS → Bigtable → chart").

`src/components/demo/demo-control-bar.tsx` — vehicle `<Select>` (options from `/api/demo/vehicles` + pool), "New vehicle" button (calls `/api/demo/vehicles` then picks random), Start/Stop buttons (POST `/api/demo/vehicle`), status badge (reuse `live-ping` dot), error toast via sonner on 503.

- [ ] **Step 4: Page composition**

`src/app/demo/page.tsx` — client component:
- state: `vin` (default from URL `?vin=` or random), `componentId` ('battery'), `range` (1h), hidden set.
- data: `useTelemetryData({ vin, range })`; control status via `demoControl('status', vin)` on mount + after actions.
- layout: control bar → schematic (+sensor chips) → data-path (flowing = status.running) → chart (TelemetryChart filtered via `seriesForComponent` + hidden) + LatestStats for the component's series.
- chart series passed to TelemetryChart: `seriesForComponent(series, componentId)` with `vehicleId={vin}`; when no series → StateView empty state (reuse).

- [ ] **Step 5: Wire navigation**

`middleware.ts` matcher: `['/fleet/:path*', '/device/:path*', '/demo']`.
`sidebar.tsx`: add a `Demo` link after Fleet (same styling), active when `pathname.startsWith('/demo')`.

- [ ] **Step 6: Verify**

Run: `cd sample-clients/data-web-client && bun run test && bun run lint && bun run build`
Expected: all tests pass (incl. new component metadata tests); lint has no NEW problems; build green.

- [ ] **Step 7: Commit**

```bash
git add sample-clients/data-web-client/src/lib/demo sample-clients/data-web-client/src/components/demo sample-clients/data-web-client/src/app/demo sample-clients/data-web-client/src/app/globals.css sample-clients/data-web-client/middleware.ts sample-clients/data-web-client/src/components/sidebar.tsx
git commit -m "feat(web): interactive /demo page — vehicle schematic, animated data path, NATS control buttons"
```

---

### Task 9: `make demo` + docs

**Files:**
- Modify: `local-dev/Makefile`, `local-dev/README.md`, `local-dev/ARCHITECTURE.md`

**Interfaces:**
- Consumes: Task 6 service, Task 8 page.
- Produces: `make demo` = ensure stack running (idempotent `make go`), `docker compose up -d vehicle-simulator`, `open http://localhost:3000/demo`.

- [ ] **Step 1: Makefile target**

```makefile
demo:
	@bash go.sh
	docker compose up -d vehicle-simulator
	@echo "Opening demo dashboard..."
	@open http://localhost:3000/demo 2>/dev/null || true
```

Add `demo` to `.PHONY` and to the `help` output.

- [ ] **Step 2: README demo section**

Add a short "Demo mode" section after the Frontend dashboard section: `make demo`, the /demo page capabilities (components → live values → animated data path → chart), and the Start/Stop buttons note. Update the Quick Start "next steps" if needed.

- [ ] **Step 3: ARCHITECTURE flow update**

Update the ingestion diagram + add a control-flow paragraph: simulator service (idle) → `commands.<VIN>.demo` → web control route; note the connector persists dynamics now.

- [ ] **Step 4: Verify**

```bash
bash -n local-dev/go.sh
make -n -C local-dev demo | head -5
grep -n 'vehicle-simulator' local-dev/docker-compose.yml local-dev/Makefile
```
Expected: no syntax errors; demo recipe prints; service + target present.

- [ ] **Step 5: Commit**

```bash
git add local-dev/Makefile local-dev/README.md local-dev/ARCHITECTURE.md
git commit -m "feat(local-dev): make demo — one-command stack + simulator + dashboard"
```

---

### Task 10: Final verification + runtime offer

- [ ] **Step 1: Go modules**

Run: `cd sample-clients/vehicle-client && go build ./... && go test ./...`; `cd base-services/nats-bigtable-connector && go build ./...`
Expected: green.

- [ ] **Step 2: Web**

Run: `cd sample-clients/data-web-client && bun run test && bun run lint && bun run build`
Expected: green (no new lint problems).

- [ ] **Step 3: Shell + realm**

```bash
bash -n local-dev/setup-automated.sh local-dev/go.sh local-dev/scripts/*.sh sample-clients/vehicle-client/entrypoint.sh
jq -e '.clients | length >= 11' local-dev/keycloak/nexus-realm.json
```
Expected: exit 0.

- [ ] **Step 4: Repo state + commit any stragglers**

`git status --short` clean (except intentionally untracked AGENTS.md/research/presentations).

- [ ] **Step 5: Report + runtime offer**

Summarize; offer to run `make demo` (docker bring-up, ~3 min) to verify end to end: random VIN registration, buttons toggling telemetry, animated page.

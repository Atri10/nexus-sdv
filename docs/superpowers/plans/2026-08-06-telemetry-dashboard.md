# Dynamic Telemetry Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the /demo dashboard into a production-quality, data-driven telemetry dashboard with per-component enable/disable control, runtime telemetry discovery, and a dynamic grid of real-time charts.

**Architecture:** Telemetry components are defined **by the simulator** (the source of truth) and exposed to the dashboard through the NATS control protocol's status reply. The web UI discovers components + sensors from that reply and discovers signals from the live data stream (any column in the data becomes a chart). No sensor names, metric lists, or chart definitions are hardcoded in the UI. Charts freeze naturally when their component stops publishing.

**Tech Stack:** Go 1.25 (vehicle-client), NATS request/reply, Next.js 15 App Router (bun), chart.js + react-chartjs-2, three.js/@react-three/drei (existing 3D scene), shadcn/ui primitives.

## Global Constraints

- No hardcoded sensor names / metric lists in the web UI. All signal knowledge comes from the simulator status reply or the live data itself.
- Backward compatibility: control requests **without** a `component` field must keep today's semantics (start/stop everything); old clients ignore the new `components` reply field (JSON passthrough).
- Signal values are strings on the wire; the existing number-vs-raw parsing in `shapeRows` stays.
- Go: std `testing` only (no testify in vehicle-client), `go test ./...` must pass.
- Web: bun only (no npm), existing jest config — new jest tests go under `__tests__/` (src/** tests are not matched by `jest.config.ts` testMatch). Do NOT touch the existing `src/lib/demo-control.test.ts` (bun:test landmine, not run by jest).
- Repo conventions: no linter gate; `bun run build` must pass; keep the four pre-existing lint errors untouched.
- Do not change: `proto/*.proto`, the nats-bigtable-connector, the chart service, device/fleet pages, `COMPONENT_ZONES` geometry (scene layout only).

---

### Task 1: Go — per-component control protocol in vehicle-client

**Files:**
- Modify: `sample-clients/vehicle-client/main.go` (controlState block, ~lines 343-401)
- Create: `sample-clients/vehicle-client/main_test.go`
- Test: `sample-clients/vehicle-client/main_test.go`

**Interfaces:**
- Consumes: existing `controlState` struct + `handle(msg *nats.Msg)` + `reply(msg, body)`.
- Produces:
  - `type componentState struct { id, label string; enabled bool; sensors []sensorInfo }`
  - `type sensorInfo struct { Name, Label string; Unit string }` (Unit empty when none)
  - `func (c *controlState) isComponentEnabled(id string) bool`
  - Control wire format: request `{"action":"start"|"stop"|"status","component":"<id>"}`, reply `{"vin","running","published","messageType","components":[{"id","label","enabled","sensors":[{"name","label","unit"}]}]}`.
  - `running` = any component enabled. `start` w/o component enables all; `stop` w/o component disables all. `start` with component enables just it; `stop` with component disables just it. Unknown component id → `{"error":"unknown component <id>"}`.
  - `handle` gains a `replyFn` injection point for tests: add field `replyFn func(msg *nats.Msg, body map[string]any)`; `reply()` delegates to it; default set in the constructor (the current implementation).

- [ ] **Step 1: Write the failing tests** (`main_test.go`, package `main`)

```go
package main

import (
	"encoding/json"
	"testing"

	"github.com/nats-io/nats.go"
)

func newTestControl(components ...string) (*controlState, *[]map[string]any) {
	var replies []map[string]any
	ctl := &controlState{vin: "VIN1001", messageType: "both"}
	ctl.components = map[string]*componentState{}
	for _, id := range components {
		ctl.components[id] = &componentState{id: id, label: id, sensors: []sensorInfo{{Name: id + ".s1", Label: "S1"}}}
	}
	ctl.replyFn = func(_ *nats.Msg, body map[string]any) { replies = append(replies, body) }
	return ctl, &replies
}

func send(ctl *controlState, payload string) {
	ctl.handle(&nats.Msg{Data: []byte(payload)})
}

func replyBody(t *testing.T, replies *[]map[string]any) map[string]any {
	t.Helper()
	if len(*replies) == 0 {
		t.Fatal("no reply captured")
	}
	body := (*replies)[len(*replies)-1]
	raw, _ := json.Marshal(body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("reply not JSON-serializable: %v", err)
	}
	return out
}

func TestControlPerComponentStartStop(t *testing.T) {
	ctl, replies := newTestControl("battery", "powertrain")

	send(ctl, `{"action":"start","component":"battery"}`)
	r := replyBody(t, replies)
	if r["running"] != true {
		t.Errorf("running = %v, want true", r["running"])
	}
	comps := r["components"].([]any)
	battery := comps[0].(map[string]any)
	if battery["enabled"] != true {
		t.Errorf("battery enabled = %v, want true", battery["enabled"])
	}
	if ctl.isComponentEnabled("battery") != true || ctl.isComponentEnabled("powertrain") != false {
		t.Errorf("component flags wrong: battery=%v powertrain=%v",
			ctl.isComponentEnabled("battery"), ctl.isComponentEnabled("powertrain"))
	}

	send(ctl, `{"action":"stop","component":"battery"}`)
	r = replyBody(t, replies)
	if r["running"] != false {
		t.Errorf("running = %v, want false after disabling last component", r["running"])
	}
}

func TestControlStartStopAll(t *testing.T) {
	ctl, replies := newTestControl("battery", "cabin")

	send(ctl, `{"action":"start"}`)
	if ctl.isComponentEnabled("battery") != true || ctl.isComponentEnabled("cabin") != true {
		t.Error("start without component should enable all")
	}
	send(ctl, `{"action":"stop"}`)
	if ctl.isComponentEnabled("battery") || ctl.isComponentEnabled("cabin") {
		t.Error("stop without component should disable all")
	}
	if replyBody(t, replies)["running"] != false {
		t.Error("running should be false after stop all")
	}
}

func TestControlStatusReportsComponents(t *testing.T) {
	ctl, replies := newTestControl("battery")
	send(ctl, `{"action":"status"}`)
	r := replyBody(t, replies)
	comps, ok := r["components"].([]any)
	if !ok || len(comps) != 1 {
		t.Fatalf("components = %#v, want one entry", r["components"])
	}
	c := comps[0].(map[string]any)
	if c["id"] != "battery" || c["label"] != "battery" {
		t.Errorf("component metadata wrong: %#v", c)
	}
	sensors := c["sensors"].([]any)
	s := sensors[0].(map[string]any)
	if s["name"] != "battery.s1" || s["label"] != "S1" {
		t.Errorf("sensor metadata wrong: %#v", s)
	}
}

func TestControlUnknownComponent(t *testing.T) {
	ctl, replies := newTestControl("battery")
	send(ctl, `{"action":"start","component":"flux_capacitor"}`)
	r := replyBody(t, replies)
	if r["error"] == nil {
		t.Error("expected error for unknown component")
	}
	if ctl.isComponentEnabled("flux_capacitor") {
		t.Error("unknown component must not be enabled")
	}
}

func TestControlInvalidJSON(t *testing.T) {
	ctl, replies := newTestControl("battery")
	send(ctl, `not json`)
	if replyBody(t, replies)["error"] == nil {
		t.Error("expected error for invalid JSON")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sample-clients/vehicle-client && go test ./...`
Expected: FAIL — `controlState` has no `components`/`replyFn` fields, build errors.

- [ ] **Step 3: Implement per-component control in main.go**

Replace the `controlState` block (current struct + `handle`) with:

```go
// sensorInfo is one publishable signal of a component. Name matches the
// Bigtable column qualifier / MetricsReport field; Label and Unit are the
// dashboard's display metadata (empty unit = plain value).
type sensorInfo struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Unit  string `json:"unit,omitempty"`
}

// componentState is one independently controllable telemetry component.
// The dashboard discovers components from this list (status reply) — no
// frontend knowledge of sensors is required.
type componentState struct {
	id      string
	label   string
	enabled bool
	sensors []sensorInfo
}

type controlState struct {
	mu          sync.Mutex
	running     bool
	published   int64
	startedAt   time.Time
	vin         string
	messageType string
	components  map[string]*componentState
	replyFn     func(msg *nats.Msg, body map[string]any)
}

// newControlState builds the component registry. This is the single source
// of truth for what the simulator can stream; keep in sync with the payload
// builders in Task 2.
func newControlState(vin, messageType string) *controlState {
	return &controlState{
		vin:         vin,
		messageType: messageType,
		components: map[string]*componentState{
			"battery": {
				id: "battery", label: "Battery",
				sensors: []sensorInfo{
					{Name: "battery.voltage", Label: "Voltage", Unit: "V"},
					{Name: "battery.current", Label: "Current", Unit: "A"},
					{Name: "battery.soc", Label: "SoC", Unit: "%"},
					{Name: "battery.temp", Label: "Temp", Unit: "°C"},
				},
			},
			"cabin": {
				id: "cabin", label: "Cabin",
				sensors: []sensorInfo{
					{Name: "make", Label: "Make"},
					{Name: "index", Label: "Model index"},
				},
			},
			"powertrain": {
				id: "powertrain", label: "Powertrain",
				sensors: []sensorInfo{
					{Name: "ENGINE_POWER", Label: "Power", Unit: "W"},
					{Name: "ENGINE_RPM", Label: "RPM", Unit: "rpm"},
					{Name: "FUEL_CAPACITY", Label: "Fuel capacity", Unit: "L"},
					{Name: "FUEL_LEVEL", Label: "Fuel", Unit: "%"},
				},
			},
			"chassis": {
				id: "chassis", label: "Chassis",
				sensors: []sensorInfo{
					{Name: "VELOCITY", Label: "Velocity", Unit: "m/s"},
					{Name: "TIRE_PRESSURE", Label: "Tire pressure", Unit: "bar"},
					{Name: "GPS_LATITUDE", Label: "Latitude"},
					{Name: "GPS_LONGITUDE", Label: "Longitude"},
					{Name: "STEERING_ANGLE_DEG", Label: "Steering", Unit: "°"},
					{Name: "ACCELERATOR_PEDAL_PCT", Label: "Accelerator", Unit: "%"},
					{Name: "BRAKE_PEDAL_PCT", Label: "Brake", Unit: "%"},
				},
			},
		},
		replyFn: func(msg *nats.Msg, body map[string]any) {
			data, _ := json.Marshal(body)
			_ = msg.Respond(data)
		},
	}
}

// handle processes one control request:
// {"action":"start"|"stop"|"status","component":"<id>"}. The component
// field is optional — without it start/stop apply to every component
// (legacy behavior). Replies are JSON {vin, running, published, messageType,
// components} on the request's reply subject, or {"error": ...}.
func (c *controlState) handle(msg *nats.Msg) {
	var req struct {
		Action    string `json:"action"`
		Component string `json:"component"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		c.reply(msg, map[string]any{"error": "invalid JSON"})
		return
	}
	c.mu.Lock()
	switch req.Action {
	case "start", "stop":
		target := req.Component == ""
		if !target {
			comp, ok := c.components[req.Component]
			if !ok {
				c.mu.Unlock()
				c.reply(msg, map[string]any{"error": "unknown component " + req.Component})
				return
			}
			comp.enabled = req.Action == "start"
			if comp.enabled && !c.running {
				c.startedAt = time.Now()
			}
		} else {
			for _, comp := range c.components {
				comp.enabled = req.Action == "start"
			}
			if req.Action == "start" {
				c.startedAt = time.Now()
			}
		}
		c.running = c.anyEnabledLocked()
	case "status":
	default:
		c.mu.Unlock()
		c.reply(msg, map[string]any{"error": "unknown action"})
		return
	}
	state := c.stateLocked()
	c.mu.Unlock()
	c.reply(msg, state)
}

func (c *controlState) anyEnabledLocked() bool {
	for _, comp := range c.components {
		if comp.enabled {
			return true
		}
	}
	return false
}

// stateLocked serializes the full control state incl. the component registry
// (id/label/enabled/sensors) so clients can discover telemetry dynamically.
func (c *controlState) stateLocked() map[string]any {
	comps := make([]map[string]any, 0, len(c.components))
	for _, comp := range c.components {
		sensors := make([]map[string]any, 0, len(comp.sensors))
		for _, s := range comp.sensors {
			sensors = append(sensors, map[string]any{"name": s.Name, "label": s.Label, "unit": s.Unit})
		}
		comps = append(comps, map[string]any{
			"id":      comp.id,
			"label":   comp.label,
			"enabled": comp.enabled,
			"sensors": sensors,
		})
	}
	return map[string]any{
		"vin":         c.vin,
		"running":     c.running,
		"published":   c.published,
		"messageType": c.messageType,
		"components":  comps,
	}
}

func (c *controlState) isComponentEnabled(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	comp, ok := c.components[id]
	return ok && comp.enabled
}

func (c *controlState) isRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running
}

func (c *controlState) reply(msg *nats.Msg, body map[string]any) {
	c.replyFn(msg, body)
}
```

- [ ] **Step 4: Wire the constructor** — in `main()` replace `ctl := &controlState{vin: v.VIN, messageType: v.MessageType}` with `ctl := newControlState(v.VIN, v.MessageType)` (line ~1004).

- [ ] **Step 5: Run tests**

Run: `cd sample-clients/vehicle-client && go test ./...`
Expected: all Task 1 tests PASS. `go build ./...` clean.

- [ ] **Step 6: Commit**

```bash
git add sample-clients/vehicle-client/main.go sample-clients/vehicle-client/main_test.go
git commit -m "feat(sim): per-component telemetry control protocol"
```

---

### Task 2: Go — per-component payload builders + gated publish loop

**Files:**
- Modify: `sample-clients/vehicle-client/main.go` (`buildBatteryTelemetry`, `buildMetricsReport`, `buildPayloads`, `publishOnce` closure)
- Test: `sample-clients/vehicle-client/main_test.go` (append)

**Interfaces:**
- Consumes: `componentState` from Task 1; existing `batteryState`, `driveState`, `publishMsg{kind, subject, payload}`.
- Produces:
  - `buildCabinTelemetry(vin string, now time.Time) (*pb.TelemetryMessage, error)` — static `make`/`index` readings.
  - `buildPowertrainReport(vin string, drive driveState, now time.Time, count int) (*pbMetrics.MetricsReport, error)` — ENGINE_POWER, ENGINE_RPM, FUEL_CAPACITY, FUEL_LEVEL only.
  - `buildChassisReport(vin string, drive driveState, now time.Time) (*pbMetrics.MetricsReport, error)` — VELOCITY, TIRE_PRESSURE, GPS_LATITUDE, GPS_LONGITUDE, VehicleDynamics (steering/accelerator/brake), IGNITION_STATE.
  - `publishMsg.subject`: battery → `telemetry-generic.{VIN}.battery`, cabin → `telemetry-generic.{VIN}.cabin`, powertrain/chassis → `telemetry.{VIN}`.
  - `(*VehicleClient) buildPayloads(...)` gains a component gate: `buildPayloads(now, battery, drive, messageType, count, enabled func(string) bool)`.

- [ ] **Step 1: Write the failing tests** (append to `main_test.go`)

```go
func TestPayloadGatingByComponent(t *testing.T) {
	v := &VehicleClient{VIN: "VIN1001"}
	now := time.Now()
	drive := driveState{enginePower: 100, engineRPM: 2000, fuelLevel: 50, velocity: 10}
	battery := batteryState{voltage: 12.5, current: 10, soc: 80, temp: 25}

	// battery + powertrain only
	msgs := v.buildPayloads(now, battery, drive, "both", 0, func(id string) bool {
		return id == "battery" || id == "powertrain"
	})
	var subjects []string
	for _, m := range msgs {
		subjects = append(subjects, m.subject)
		if m.subject == "telemetry-generic.VIN1001.battery" {
			if !bytes.Contains(m.payload, []byte("battery.voltage")) {
				t.Error("battery message missing battery.voltage")
			}
			if bytes.Contains(m.payload, []byte(`"make"`)) {
				t.Error("battery message must not contain cabin static sensors")
			}
		}
		if m.subject == "telemetry.VIN1001" {
			var mr pbMetrics.MetricsReport
			if err := proto.Unmarshal(m.payload, &mr); err != nil {
				t.Fatalf("unmarshal MetricsReport: %v", err)
			}
			var vtd pbVehicle.VehicleTelemetryData
			if err := mr.ReportData.UnmarshalTo(&vtd); err != nil {
				t.Fatalf("unpack VehicleTelemetryData: %v", err)
			}
			if vtd.ENGINE_RPM == 0 || vtd.VELOCITY != 0 {
				t.Errorf("powertrain report wrong: rpm=%v velocity=%v (velocity must be absent)", vtd.ENGINE_RPM, vtd.VELOCITY)
			}
		}
	}
	want := map[string]bool{
		"telemetry-generic.VIN1001.battery": true,
		"telemetry.VIN1001":                 true,
	}
	if len(subjects) != 2 {
		t.Fatalf("subjects = %v, want 2 messages", subjects)
	}
	for _, s := range subjects {
		if !want[s] {
			t.Errorf("unexpected subject %q", s)
		}
	}
}

func TestPayloadAllDisabled(t *testing.T) {
	v := &VehicleClient{VIN: "VIN1001"}
	msgs := v.buildPayloads(time.Now(), batteryState{}, driveState{}, "both", 0, func(string) bool { return false })
	if len(msgs) != 0 {
		t.Errorf("expected no payloads when all components disabled, got %d", len(msgs))
	}
}

func TestBuildCabinTelemetry(t *testing.T) {
	msg, err := buildCabinTelemetry("VIN1001", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.SensorData) != 2 {
		t.Fatalf("cabin sensors = %d, want 2", len(msg.SensorData))
	}
	if msg.SensorData[0].Sensor != "make" || msg.SensorData[1].Sensor != "index" {
		t.Errorf("cabin sensors wrong: %v %v", msg.SensorData[0].Sensor, msg.SensorData[1].Sensor)
	}
}
```

Add imports: `bytes`, `time`, `github.com/golang/protobuf/proto` → check go.mod for the protobuf import path used by main.go (it imports `"google.golang.org/protobuf/proto"` and the generated `pbMetrics`/`pbVehicle` aliases — reuse the exact aliases from main.go's import block).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sample-clients/vehicle-client && go test ./...`
Expected: FAIL — `buildCabinTelemetry`, `buildPowertrainReport`, `buildChassisReport` undefined; `buildPayloads` signature mismatch.

- [ ] **Step 3: Split the payload builders**

- `buildBatteryTelemetry` stays as-is (battery.* sensors only).
- Add `buildCabinTelemetry` (copy of the static readings from `buildBatteryTelemetry`):

```go
// buildCabinTelemetry constructs the static cabin readings (make/index).
func buildCabinTelemetry(vin string, now time.Time) (*pb.TelemetryMessage, error) {
	return &pb.TelemetryMessage{
		MessageId:     uuid.New().String(),
		SchemaVersion: 1,
		DeviceId:      vin,
		SensorData: []*pb.SensorReading{
			{Timestamp: timestamppb.New(now), Value: "Nexus SDV", DataType: pb.DataType_STATIC, Sensor: "make"},
			{Timestamp: timestamppb.New(now), Value: "2026", DataType: pb.DataType_STATIC, Sensor: "index"},
		},
	}, nil
}
```

- Remove `make`/`index` readings from `buildBatteryTelemetry` (they move to cabin).
- Split `buildMetricsReport` into `buildPowertrainReport` (fields ENGINE_POWER, ENGINE_RPM, FUEL_CAPACITY, FUEL_LEVEL) and `buildChassisReport` (VELOCITY, TIRE_PRESSURE, GPS_LATITUDE, GPS_LONGITUDE, VehicleDynamics, IGNITION_STATE). Keep the Any-wrapping + MetricsReport envelope identical. `buildMetricsReport` may be deleted if no other caller remains (check with `grep`).

- [ ] **Step 4: Gate `buildPayloads` by enabled components**

```go
func (v *VehicleClient) buildPayloads(now time.Time, battery batteryState, drive driveState, messageType string, count int, enabled func(string) bool) []publishMsg {
	var out []publishMsg
	emit := func(kind, subject string, payload []byte) {
		if payload != nil {
			out = append(out, publishMsg{kind: kind, subject: subject, payload: payload})
		}
	}
	if messageType == "telemetry" || messageType == "both" {
		if enabled("battery") {
			if msg, err := buildBatteryTelemetry(v.VIN, battery, now); err == nil {
				if payload, err := proto.Marshal(msg); err == nil {
					emit("telemetry", v.buildTelemetrySubject("battery"), payload)
				}
			}
		}
		if enabled("cabin") {
			if msg, err := buildCabinTelemetry(v.VIN, now); err == nil {
				if payload, err := proto.Marshal(msg); err == nil {
					emit("telemetry", v.buildTelemetrySubject("cabin"), payload)
				}
			}
		}
	}
	if messageType == "metrics_report" || messageType == "both" {
		if enabled("powertrain") {
			if report, err := buildPowertrainReport(v.VIN, drive, now, count); err == nil {
				if payload, err := proto.Marshal(report); err == nil {
					emit("metrics_report", v.buildMetricsReportSubject(), payload)
				}
			}
		}
		if enabled("chassis") {
			if report, err := buildChassisReport(v.VIN, drive, now); err == nil {
				if payload, err := proto.Marshal(report); err == nil {
					emit("metrics_report", v.buildMetricsReportSubject(), payload)
				}
			}
		}
	}
	return out
}
```

- [ ] **Step 5: Update the publish loop** — in `PublishTelemetryContinuously`, replace the `for _, m := range v.buildPayloads(now, battery, drive, v.MessageType, messageCount)` call with a component-gated call:

```go
for _, m := range v.buildPayloads(now, battery, drive, v.MessageType, messageCount, ctl.isComponentEnabled) {
```

(The existing `ctl.isRunning()` gate around `publishOnce()` stays — it now means "any component enabled".)

- [ ] **Step 6: Run tests + build**

Run: `cd sample-clients/vehicle-client && go test ./... && go build ./...`
Expected: PASS; `go vet ./...` clean.

- [ ] **Step 7: Commit**

```bash
git add sample-clients/vehicle-client/main.go sample-clients/vehicle-client/main_test.go
git commit -m "feat(sim): emit per-component telemetry payloads gated by control state"
```

---

### Task 3: Web — demo control lib + API route + jest tests

**Files:**
- Modify: `sample-clients/data-web-client/src/lib/demo-control.ts`
- Modify: `sample-clients/data-web-client/src/app/api/demo/vehicle/route.ts`
- Create: `sample-clients/data-web-client/__tests__/demo/demo-control.test.ts`
- Test: `__tests__/demo/demo-control.test.ts`

**Interfaces:**
- Consumes: `DemoAction`, `DemoControlReply`, `demoControl(action, vin)` from Task 0 (existing).
- Produces:
  - `export interface SignalInfo { name: string; label: string; unit?: string }`
  - `export interface ComponentStatus { id: string; label: string; enabled: boolean; sensors: SignalInfo[] }`
  - `export interface DemoControlReply { vin: string; running: boolean; published: number; messageType: string; components?: ComponentStatus[]; error?: string }`
  - `export function demoControl(action: DemoAction, vin: string, component?: string): Promise<DemoControlReply>`
  - Route: accepts optional `component` body field, passes through.

- [ ] **Step 1: Write the failing jest tests**

```ts
// __tests__/demo/demo-control.test.ts
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const sc = new (require('nats').StringCodec)();

const REPLY = {
  vin: 'VIN1001',
  running: true,
  published: 3,
  messageType: 'both',
  components: [
    { id: 'battery', label: 'Battery', enabled: true, sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }] },
  ],
};

const captured: Array<{ subject: string; payload: string; timeout: number }> = [];
const fakeRequest = jest.fn(async (_subject: string, payload: Uint8Array, opts: { timeout: number }) => {
  captured.push({ subject: _subject, payload: sc.decode(payload), timeout: opts.timeout });
  return { data: sc.encode(JSON.stringify(REPLY)) };
});

jest.mock('@/lib/nats', () => ({
  getNatsScoringConnection: jest.fn(async () => ({ request: fakeRequest })),
}));

import { demoControl } from '@/lib/demo-control';

beforeEach(() => {
  captured.length = 0;
  fakeRequest.mockClear();
});

describe('demoControl per-component', () => {
  it('sends { action, component } JSON when a component is given', async () => {
    const reply = await demoControl('start', 'VIN1001', 'battery');
    expect(captured[0].subject).toBe('commands.VIN1001.demo');
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'start', component: 'battery' });
    expect(captured[0].timeout).toBe(3000);
    expect(reply.components?.[0]?.sensors[0]?.unit).toBe('V');
  });

  it('omits the component field when none is given (legacy behavior)', async () => {
    await demoControl('stop', 'VIN1001');
    expect(JSON.parse(captured[0].payload)).toEqual({ action: 'stop' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/demo-control.test.ts`
Expected: FAIL — `demoControl` has no third param / types missing.

- [ ] **Step 3: Implement `demo-control.ts` changes**

```ts
export interface SignalInfo {
  name: string;
  label: string;
  unit?: string;
}

export interface ComponentStatus {
  id: string;
  label: string;
  enabled: boolean;
  sensors: SignalInfo[];
}

export interface DemoControlReply {
  vin: string;
  running: boolean;
  published: number;
  messageType: string;
  components?: ComponentStatus[];
  error?: string;
}

export async function demoControl(action: DemoAction, vin: string, component?: string): Promise<DemoControlReply> {
  const nc = await getNatsScoringConnection();
  let reply;
  try {
    reply = await nc.request(
      `commands.${vin}.demo`,
      sc.encode(JSON.stringify(component ? { action, component } : { action })),
      { timeout: 3000 }
    );
  } catch {
    throw new DemoSimulatorOfflineError();
  }
  return JSON.parse(sc.decode(reply.data)) as DemoControlReply;
}
```

(Keep `DemoSimulatorOfflineError`, `discoverSimulator` unchanged.)

- [ ] **Step 4: Update the route** (`src/app/api/demo/vehicle/route.ts`)

```ts
let body: { action?: unknown; vin?: unknown; component?: unknown };
...
const { action, vin, component } = body ?? {};
if (
  typeof action !== 'string' ||
  !['start', 'stop', 'status'].includes(action) ||
  typeof vin !== 'string' ||
  !vin
) {
  return NextResponse.json({ error: 'expected { action: start|stop|status, vin: string, component?: string }' }, { status: 400 });
}
...
const reply = await demoControl(
  action as DemoAction,
  vin,
  typeof component === 'string' && component ? component : undefined
);
```

- [ ] **Step 5: Run tests**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/demo-control.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sample-clients/data-web-client/src/lib/demo-control.ts sample-clients/data-web-client/src/app/api/demo/vehicle/route.ts sample-clients/data-web-client/__tests__/demo/demo-control.test.ts
git commit -m "feat(web): per-component demo control API"
```

---

### Task 4: Web — telemetry discovery lib + page state

**Files:**
- Create: `sample-clients/data-web-client/src/lib/telemetry-discovery.ts`
- Modify: `sample-clients/data-web-client/src/app/demo/page.tsx` (state + status effect + `runAction` + `componentSeries`)
- Test: `__tests__/demo/telemetry-discovery.test.ts`

**Interfaces:**
- Consumes: `ComponentStatus`, `SignalInfo` from Task 3; `ChartSeries` from `@/lib/telemetry-chart-utils`; `useTelemetryData`.
- Produces:
  - `qualifierOf(column: string): string` — strips `dynamic:`/`static:` prefix.
  - `componentForSignal(components: ComponentStatus[] | null, qualifier: string): ComponentStatus | undefined`
  - `signalsForComponent(components: ComponentStatus[] | null, componentId: string): SignalInfo[]`
  - `unitForSignal(components: ComponentStatus[] | null, qualifier: string): string | undefined`
  - `componentsForSeries(components: ComponentStatus[] | null, series: ChartSeries[]): Map<string, ComponentStatus[]>` — groups series keys by component id (unknown → key `'unassigned'`).
  - Page: `components: ComponentStatus[] | null` state; status poll every 5 s; `componentSeries` derived via discovered sensors.

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/demo/telemetry-discovery.test.ts
import {
  qualifierOf,
  componentForSignal,
  signalsForComponent,
  unitForSignal,
  componentsForSeries,
} from '@/lib/telemetry-discovery';
import type { ComponentStatus } from '@/lib/demo-control';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery', label: 'Battery', enabled: true,
    sensors: [
      { name: 'battery.voltage', label: 'Voltage', unit: 'V' },
      { name: 'battery.soc', label: 'SoC', unit: '%' },
    ],
  },
  { id: 'cabin', label: 'Cabin', enabled: false, sensors: [{ name: 'make', label: 'Make' }] },
];

describe('telemetry discovery', () => {
  it('strips family prefixes', () => {
    expect(qualifierOf('dynamic:battery.voltage')).toBe('battery.voltage');
    expect(qualifierOf('static:make')).toBe('make');
    expect(qualifierOf('battery.soc')).toBe('battery.soc');
  });

  it('maps a signal qualifier to its component', () => {
    expect(componentForSignal(COMPONENTS, 'battery.voltage')?.id).toBe('battery');
    expect(componentForSignal(COMPONENTS, 'make')?.id).toBe('cabin');
    expect(componentForSignal(COMPONENTS, 'ENGINE_RPM')).toBeUndefined();
    expect(componentForSignal(null, 'battery.voltage')).toBeUndefined();
  });

  it('returns sensors for a component', () => {
    expect(signalsForComponent(COMPONENTS, 'battery')).toHaveLength(2);
    expect(signalsForComponent(COMPONENTS, 'missing')).toEqual([]);
  });

  it('resolves units from discovered metadata', () => {
    expect(unitForSignal(COMPONENTS, 'battery.voltage')).toBe('V');
    expect(unitForSignal(COMPONENTS, 'make')).toBeUndefined();
  });

  it('groups series keys by component', () => {
    const series = [
      { key: 'VIN1|dynamic:battery.voltage' },
      { key: 'VIN1|static:make' },
      { key: 'VIN1|dynamic:ENGINE_RPM' },
    ] as never[];
    const groups = componentsForSeries(COMPONENTS, series as never[]);
    expect(groups.get('battery')?.map((s) => s.key)).toEqual(['VIN1|dynamic:battery.voltage']);
    expect(groups.get('cabin')?.map((s) => s.key)).toEqual(['VIN1|static:make']);
    expect(groups.get('unassigned')?.map((s) => s.key)).toEqual(['VIN1|dynamic:ENGINE_RPM']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/telemetry-discovery.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `telemetry-discovery.ts`**

```ts
import type { ComponentStatus, SignalInfo } from '@/lib/demo-control';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

/** Column qualifier without the family prefix ('dynamic:battery.voltage' → 'battery.voltage'). */
export function qualifierOf(column: string): string {
  const colon = column.indexOf(':');
  return colon > -1 ? column.slice(colon + 1) : column;
}

/** The component that owns a signal qualifier, or undefined when unknown. */
export function componentForSignal(
  components: ComponentStatus[] | null,
  qualifier: string
): ComponentStatus | undefined {
  if (!components) return undefined;
  return components.find((c) => c.sensors.some((s) => s.name === qualifier));
}

/** Sensors declared for a component id (empty when the component is unknown). */
export function signalsForComponent(components: ComponentStatus[] | null, componentId: string): SignalInfo[] {
  return components?.find((c) => c.id === componentId)?.sensors ?? [];
}

/** Unit declared for a signal qualifier, or undefined. */
export function unitForSignal(components: ComponentStatus[] | null, qualifier: string): string | undefined {
  return componentForSignal(components, qualifier)?.sensors.find((s) => s.name === qualifier)?.unit;
}

/**
 * Groups chart series by the component that owns them (key 'unassigned' for
 * signals no discovered component declares — they still render, just
 * ungrouped). Order follows the components array, then insertion.
 */
export function componentsForSeries(
  components: ComponentStatus[] | null,
  series: ChartSeries[]
): Map<string, ChartSeries[]> {
  const groups = new Map<string, ChartSeries[]>();
  for (const s of series) {
    const qualifier = qualifierOf(s.column);
    const id = componentForSignal(components, qualifier)?.id ?? 'unassigned';
    const list = groups.get(id);
    if (list) list.push(s);
    else groups.set(id, [s]);
  }
  return groups;
}
```

- [ ] **Step 4: Rework demo page state** (`src/app/demo/page.tsx`)

- Add state: `const [components, setComponents] = useState<ComponentStatus[] | null>(null);`
- The existing status effect (POST status on `vin` change) now also stores `reply.components`:

```tsx
.then((reply: (DemoStatus & { error?: string; components?: ComponentStatus[] }) | null) => {
  if (ignore) return;
  setStatus(reply && !reply.error ? { running: reply.running, published: reply.published } : null);
  if (reply && !reply.error && reply.components) setComponents(reply.components);
  else setComponents(null);
})
```

- Add a 5 s poll that re-runs the status fetch (discover simulator restarts / state changes from other clients). Extract the status fetch into a `useCallback` `refreshStatus` and call it from a `useEffect` with `setInterval(refreshStatus, 5000)` (keep the vin-change effect calling it once).
- `runAction` (start/stop) already re-discovers + posts; after a successful reply, also `setComponents(reply.components ?? null)`.
- Replace the derived series mapping:

```tsx
const component = components?.find((c) => c.id === componentId) ?? null;
const componentSeries = useMemo(
  () => (component ? series.filter((s) => component.sensors.some((sig) => qualifierOf(s.column) === sig.name)) : []),
  [series, component]
);
```

Remove the `DEMO_COMPONENTS` import from page.tsx; keep `seriesForComponent` import only if still used (it is not — delete).

- [ ] **Step 5: Run tests + typecheck**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/telemetry-discovery.test.ts && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sample-clients/data-web-client/src/lib/telemetry-discovery.ts sample-clients/data-web-client/src/app/demo/page.tsx sample-clients/data-web-client/__tests__/demo/telemetry-discovery.test.ts
git commit -m "feat(web): runtime telemetry discovery layer + page state"
```

---

### Task 5: Web — component control panel

**Files:**
- Create: `sample-clients/data-web-client/src/components/demo/component-panel.tsx`
- Modify: `sample-clients/data-web-client/src/app/demo/page.tsx` (render panel)
- Test: `__tests__/demo/component-panel.test.tsx` (react-testing-library; mirror existing jsdom project setup)

**Interfaces:**
- Consumes: `ComponentStatus` (Task 3), `onToggle(componentId: string, enable: boolean)` callback, `busy` flag, `simulatorVin: string | null`.
- Produces: `ComponentPanel({ components, simulatorVin, busy, onToggle })` — renders one card per component: label, status badge (`Active` = enabled + simulator online, `Paused` = disabled + simulator online, `Offline` = simulator unknown), `Switch` checked = enabled, sensor chips (name + unit). `onToggle` fired with the new desired state.

- [ ] **Step 1: Write the failing test**

```tsx
// __tests__/demo/component-panel.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentPanel } from '@/components/demo/component-panel';
import type { ComponentStatus } from '@/lib/demo-control';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery', label: 'Battery', enabled: true,
    sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }],
  },
  {
    id: 'cabin', label: 'Cabin', enabled: false,
    sensors: [{ name: 'make', label: 'Make' }],
  },
];

describe('ComponentPanel', () => {
  it('renders a card per component with status and sensors', () => {
    render(<ComponentPanel components={COMPONENTS} simulatorVin="VIN1001" busy={false} onToggle={() => {}} />);
    expect(screen.getByText('Battery')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('battery.voltage')).toBeInTheDocument();
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('shows Offline when the simulator is unknown', () => {
    render(<ComponentPanel components={COMPONENTS} simulatorVin={null} busy={false} onToggle={() => {}} />);
    expect(screen.getAllByText('Offline')).toHaveLength(2);
  });

  it('calls onToggle with the new desired state', () => {
    const onToggle = jest.fn();
    render(<ComponentPanel components={COMPONENTS} simulatorVin="VIN1001" busy={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch', { name: /cabin/i }));
    expect(onToggle).toHaveBeenCalledWith('cabin', true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/component-panel.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `component-panel.tsx`**

```tsx
'use client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { ComponentStatus } from '@/lib/demo-control';

type ComponentPhase = 'active' | 'paused' | 'offline';

function phaseFor(component: ComponentStatus, online: boolean): ComponentPhase {
  if (!online) return 'offline';
  return component.enabled ? 'active' : 'paused';
}

const PHASE_LABEL: Record<ComponentPhase, string> = {
  active: 'Active',
  paused: 'Paused',
  offline: 'Offline',
};

const PHASE_CLASS: Record<ComponentPhase, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  offline: 'bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400',
};

export interface ComponentPanelProps {
  components: ComponentStatus[] | null;
  /** Discovered simulator VIN, or null when the simulator is unreachable. */
  simulatorVin: string | null;
  busy: boolean;
  onToggle: (componentId: string, enable: boolean) => void;
}

/**
 * Component control panel: one card per discovered component with an
 * enable/disable switch and an Active / Paused / Offline phase badge.
 * Renders nothing until components are discovered (simulator offline).
 */
export function ComponentPanel({ components, simulatorVin, busy, onToggle }: ComponentPanelProps) {
  if (!components || components.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No components discovered — start the simulator to see component controls.
        </CardContent>
      </Card>
    );
  }
  const online = simulatorVin !== null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Components</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {components.map((component) => {
          const phase = phaseFor(component, online);
          return (
            <div
              key={component.id}
              className="flex items-start justify-between gap-2 rounded-lg border border-border/60 p-3"
              data-testid={`component-${component.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{component.label}</span>
                  <Badge variant="secondary" className={`gap-1 px-1.5 py-0 text-[10px] ${PHASE_CLASS[phase]}`}>
                    {PHASE_LABEL[phase]}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {component.sensors.map((s) => (
                    <span key={s.name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {s.name}
                      {s.unit ? ` · ${s.unit}` : ''}
                    </span>
                  ))}
                </div>
              </div>
              <Switch
                aria-label={`${component.label} component`}
                checked={component.enabled}
                disabled={busy || !online}
                onCheckedChange={(next) => onToggle(component.id, next)}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Wire into the demo page** — render `<ComponentPanel components={components} simulatorVin={simulatorVin} busy={busy} onToggle={toggleComponent} />` above the pipeline section, with:

```tsx
const toggleComponent = useCallback(
  async (componentId: string, enable: boolean) => {
    setBusy(true);
    try {
      const res = await fetch('/api/demo/vehicle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: enable ? 'start' : 'stop', component: componentId, vin }),
      });
      const reply = (await res.json().catch(() => null)) as (DemoStatus & { error?: string; components?: ComponentStatus[] }) | null;
      if (!res.ok || !reply || reply.error) {
        const { toast } = await import('sonner');
        toast.error(reply?.error ?? `HTTP ${res.status}`);
        return;
      }
      setStatus({ running: reply.running, published: reply.published });
      if (reply.components) setComponents(reply.components);
    } catch (e) {
      const { toast } = await import('sonner');
      toast.error(e instanceof Error ? e.message : 'Failed to toggle component');
    } finally {
      setBusy(false);
    }
  },
  [vin]
);
```

- [ ] **Step 5: Run tests + build**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/ && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sample-clients/data-web-client/src/components/demo/component-panel.tsx sample-clients/data-web-client/src/app/demo/page.tsx sample-clients/data-web-client/__tests__/demo/component-panel.test.tsx
git commit -m "feat(web): component control panel with Active/Paused/Offline states"
```

---

### Task 6: Web — dynamic chart grid + expandable detail

**Files:**
- Create: `sample-clients/data-web-client/src/components/demo/signal-chart.tsx`
- Create: `sample-clients/data-web-client/src/components/demo/chart-grid.tsx`
- Create: `sample-clients/data-web-client/src/components/demo/chart-detail-dialog.tsx`
- Modify: `sample-clients/data-web-client/src/app/demo/page.tsx` (replace the single-chart section with the grid)
- Test: `__tests__/demo/signal-chart.test.tsx` (renders label + expand; pause overlay when its component is disabled)

**Interfaces:**
- Consumes: `ChartSeries`, `TelemetryChart` (existing), `useChartTheme`, `Dialog`/`DialogTrigger`/`DialogContent` from `@/components/ui/dialog`, `ComponentStatus` for the paused state, `unitForSignal`.
- Produces:
  - `SignalChart({ series, unit, theme, paused, onExpand })` — memoized card: header (label + unit + latest value + live dot), 48-line chart, expand button; `paused` overlays a "Paused — history retained" chip.
  - `ChartGrid({ groups, components, hidden, theme, units, onToggleSeries })` — renders group headers (component labels) + one `SignalChart` per series key; `hidden` toggles work as today.
  - `ChartDetailDialog({ open, onOpenChange, series, unit, theme })` — full-size `TelemetryChart` in a Dialog.

- [ ] **Step 1: Write the failing test**

```tsx
// __tests__/demo/signal-chart.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { SignalChart } from '@/components/demo/signal-chart';

const SERIES = {
  vin: 'VIN1001',
  column: 'dynamic:battery.voltage',
  key: 'VIN1001|dynamic:battery.voltage',
  label: 'battery.voltage',
  color: '#3B82F6',
  points: [
    { x: 1, y: 12.5 },
    { x: 2, y: 12.6 },
  ],
};

describe('SignalChart', () => {
  it('shows label, unit and latest value', () => {
    render(<SignalChart series={SERIES} unit="V" paused={false} onExpand={() => {}} />);
    expect(screen.getByText('battery.voltage')).toBeInTheDocument();
    expect(screen.getByText('12.6 V')).toBeInTheDocument();
  });

  it('marks paused charts and keeps history', () => {
    render(<SignalChart series={SERIES} unit="V" paused onExpand={() => {}} />);
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });

  it('fires onExpand', () => {
    const onExpand = jest.fn();
    render(<SignalChart series={SERIES} unit="V" paused={false} onExpand={onExpand} />);
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(onExpand).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/signal-chart.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `signal-chart.tsx`**

```tsx
'use client';
import { memo } from 'react';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { Maximize2 } from 'lucide-react';
import { formatValue } from '@/lib/telemetry-chart-utils';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-48 w-full rounded-lg" />,
});

export interface SignalChartProps {
  series: ChartSeries;
  unit?: string;
  paused: boolean;
  theme: ChartThemeColors;
  onExpand: () => void;
}

function latestPoint(series: ChartSeries): number | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const p = series.points[i];
    if (p.y != null) return p.y;
  }
  return null;
}

/**
 * One real-time chart card per telemetry signal. Cards are memoized on the
 * series identity + last point so paused signals skip re-renders entirely.
 */
export const SignalChart = memo(function SignalChart({ series, unit, paused, theme, onExpand }: SignalChartProps) {
  const latest = latestPoint(series);
  return (
    <div className="group relative flex flex-col rounded-lg border border-border/60 bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: series.color }} aria-hidden="true" />
          <span className="truncate font-mono text-xs text-foreground">{series.label}</span>
          {!paused && <span className="relative flex h-2 w-2" aria-hidden="true"><span className="live-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>}
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-sm font-semibold tabular-nums">
            {latest != null ? `${formatValue(latest)}${unit ? ` ${unit}` : ''}` : '—'}
          </span>
          <button
            type="button"
            aria-label="Expand chart"
            onClick={onExpand}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="relative mt-2 h-48">
        <TelemetryChart
          vehicleId={series.vin}
          series={[series]}
          type="line"
          axisMode="single"
          hidden={new Set()}
          theme={theme}
          resetZoomToken={0}
          units={unit ? { [series.key]: unit } : {}}
        />
        {paused && (
          <div className="absolute inset-0 flex items-center justify-center rounded bg-background/60 backdrop-blur-[1px]">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              Paused — history retained
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
```

(Note: memo comparator — default shallow compare on props; series identity changes only when new points arrive, so paused charts with stable series refs skip re-renders. The page must keep the series array from `useTelemetryData` as-is, which it does.)

- [ ] **Step 4: Implement `chart-grid.tsx`**

```tsx
'use client';
import { Fragment, useMemo, useState } from 'react';
import { SignalChart } from '@/components/demo/signal-chart';
import { ChartDetailDialog } from '@/components/demo/chart-detail-dialog';
import { componentsForSeries, qualifierOf, unitForSignal } from '@/lib/telemetry-discovery';
import type { ComponentStatus } from '@/lib/demo-control';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

export interface ChartGridProps {
  series: ChartSeries[];
  components: ComponentStatus[] | null;
  hidden: Set<string>;
  theme: ChartThemeColors;
  onToggleSeries: (key: string) => void;
}

/**
 * Responsive grid of one real-time chart per discovered signal, grouped by
 * the component that owns it. Clicking any chart opens a full-size detail
 * dialog. New signals appear automatically — nothing here is hardcoded.
 */
export function ChartGrid({ series, components, hidden, theme, onToggleSeries }: ChartGridProps) {
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const groups = useMemo(() => componentsForSeries(components, series), [components, series]);
  const order = useMemo(() => {
    const ids = (components ?? []).map((c) => c.id).filter((id) => groups.has(id));
    if (groups.has('unassigned')) ids.push('unassigned');
    return ids;
  }, [components, groups]);

  const detailSeries = detailKey ? series.find((s) => s.key === detailKey) : undefined;

  return (
    <div className="space-y-6">
      {order.map((componentId) => {
        const label =
          componentId === 'unassigned'
            ? 'Other signals'
            : components?.find((c) => c.id === componentId)?.label ?? componentId;
        const groupSeries = groups.get(componentId) ?? [];
        const visible = groupSeries.filter((s) => !hidden.has(s.key));
        return (
          <Fragment key={componentId}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold tracking-wide text-foreground">{label}</h3>
              <button
                type="button"
                onClick={() => groupSeries.forEach((s) => onToggleSeries(s.key))}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {visible.length === groupSeries.length ? 'Hide all' : 'Show all'}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {groupSeries.map((s) => (
                <SignalChart
                  key={s.key}
                  series={s}
                  unit={unitForSignal(components, qualifierOf(s.column))}
                  paused={hidden.has(s.key) || componentId === 'unassigned' ? false : !(components?.find((c) => c.id === componentId)?.enabled ?? true)}
                  theme={theme}
                  onExpand={() => setDetailKey(s.key)}
                />
              ))}
            </div>
          </Fragment>
        );
      })}
      <ChartDetailDialog
        open={detailKey !== null}
        onOpenChange={(open) => { if (!open) setDetailKey(null); }}
        series={detailSeries}
        unit={detailSeries ? unitForSignal(components, qualifierOf(detailSeries.column)) : undefined}
        theme={theme}
      />
    </div>
  );
}
```

(Note: `paused` = the owning component is discovered but disabled — the simulator stops publishing it, so the chart freezes with history. `hidden` series render dimmed via the existing toggle buttons above the grid.)

- [ ] **Step 5: Implement `chart-detail-dialog.tsx`**

```tsx
'use client';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatValue } from '@/lib/telemetry-chart-utils';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';
import type { ChartThemeColors } from '@/hooks/use-chart-theme';

const TelemetryChart = dynamic(() => import('@/components/telemetry-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full rounded-lg" />,
});

export interface ChartDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  series?: ChartSeries;
  unit?: string;
  theme: ChartThemeColors;
}

/** Full-size detailed view of one telemetry signal (zoom + axes). */
export function ChartDetailDialog({ open, onOpenChange, series, unit, theme }: ChartDetailDialogProps) {
  const last = series ? [...series.points].reverse().find((p) => p.y != null) : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: series?.color }} />
            {series?.label}
            {unit ? ` · ${unit}` : ''}
            {last?.y != null && <span className="ml-auto font-semibold tabular-nums">{formatValue(last.y)}{unit ? ` ${unit}` : ''}</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="h-80">
          {series && (
            <TelemetryChart
              vehicleId={series.vin}
              series={[series]}
              type="line"
              axisMode="single"
              hidden={new Set()}
              theme={theme}
              resetZoomToken={0}
              units={unit ? { [series.key]: unit } : {}}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Replace the demo page's chart section** — delete the old `StateView`-wrapped single chart block and render:

```tsx
<FadeIn>
  <ChartGrid series={series} components={components} hidden={hidden} theme={theme} onToggleSeries={toggle} />
</FadeIn>
```

Keep the `toggle` handler and the series visibility chips (they now drive the grid's hide-all/show-all per group and dim individual cards). Remove the now-unused `TelemetryChart` dynamic import, `LatestStats` import, `unitsForSeries` import, and `StateView` import from page.tsx (verify no other usage on the page).

- [ ] **Step 7: Run tests + build**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/ && bun run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sample-clients/data-web-client/src/components/demo/signal-chart.tsx sample-clients/data-web-client/src/components/demo/chart-grid.tsx sample-clients/data-web-client/src/components/demo/chart-detail-dialog.tsx sample-clients/data-web-client/src/app/demo/page.tsx sample-clients/data-web-client/__tests__/demo/signal-chart.test.tsx
git commit -m "feat(web): dynamic per-signal chart grid with expandable detail"
```

---

### Task 7: Web — discovery-driven vehicle scene + schematic + KPI strip

**Files:**
- Modify: `sample-clients/data-web-client/src/components/demo/vehicle-schematic.tsx` (accept `components` prop; drop `DEMO_COMPONENTS` import)
- Modify: `sample-clients/data-web-client/src/components/scene/demo-scene.tsx` (accept `components` prop for zone labels)
- Modify: `sample-clients/data-web-client/src/components/latest-stats.tsx` (optional `units` override prop)
- Modify: `sample-clients/data-web-client/src/app/demo/page.tsx` (wire props; remove `DEMO_COMPONENTS` dependency entirely)
- Test: `__tests__/demo/vehicle-schematic.test.tsx`

**Interfaces:**
- Consumes: `ComponentStatus` (Task 3), `qualifierOf`/`signalsForComponent` (Task 4), existing `NODE_POSITIONS`/`COMPONENT_ZONES` geometry.
- Produces:
  - `VehicleSchematic({ componentId, onSelect, series, components })` — node circles/labels from `components` (position via `NODE_POSITIONS[id]`, fallback = evenly spread along the body line), sensor chips from `signalsForComponent`.
  - `DemoScene({ ..., components })` — ZoneBox labels from discovered components (fallback to zone.id).
  - `LatestStats({ series, hidden, units? })` — `units` overrides `unitForQualifier` when provided.

- [ ] **Step 1: Write the failing test**

```tsx
// __tests__/demo/vehicle-schematic.test.tsx
import { render, screen } from '@testing-library/react';
import { VehicleSchematic } from '@/components/demo/vehicle-schematic';
import type { ComponentStatus } from '@/lib/demo-control';

const COMPONENTS: ComponentStatus[] = [
  {
    id: 'battery', label: 'Battery', enabled: true,
    sensors: [{ name: 'battery.voltage', label: 'Voltage', unit: 'V' }],
  },
  { id: 'cabin', label: 'Cabin', enabled: false, sensors: [] },
];

const SERIES = [
  {
    vin: 'VIN1001', column: 'dynamic:battery.voltage', key: 'VIN1001|dynamic:battery.voltage',
    label: 'battery.voltage', color: '#3B82F6',
    points: [{ x: 1, y: 12.5 }, { x: 2, y: 12.6 }],
  },
];

describe('VehicleSchematic', () => {
  it('renders discovered component nodes and live sensor chips', () => {
    render(
      <VehicleSchematic componentId="battery" onSelect={() => {}} series={SERIES} components={COMPONENTS} />
    );
    expect(screen.getByRole('button', { name: /Battery/ })).toBeInTheDocument();
    expect(screen.getByText('battery.voltage')).toBeInTheDocument();
    expect(screen.getByText('12.6 V')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-clients/data-web-client && npm test -- __tests__/demo/vehicle-schematic.test.tsx`
Expected: FAIL — prop missing.

- [ ] **Step 3: Refactor `vehicle-schematic.tsx`**

- Change props to include `components: ComponentStatus[] | null`.
- Node list: `const nodes = (components ?? []).map((c) => ({ id: c.id, label: c.label, pos: NODE_POSITIONS[c.id] ?? defaultNodePosition(c.id, index) }))` where `defaultNodePosition` spreads fallback ids evenly at y=118 across x∈[140,520].
- `colorFor`/`latestValuesFor` calls: replace `DEMO_COMPONENTS` sensor lookup with `signalsForComponent(components, componentId)`; the chips map discovered sensors → latest value from series (qualifier match via `qualifierOf`).
- The active node highlight uses `componentId` as before; aria-label uses discovered description-less label + sensor names.
- Keep the SVG car artwork unchanged.

- [ ] **Step 4: Refactor `demo-scene.tsx`**

- Add `components?: ComponentStatus[] | null` prop; pass to each `ZoneBox` as `labelOverride`; ZoneBox renders `<Html>`-free label — the scene already labels zones via `zone.label`? Check current implementation: if zones have no labels, add a `label` prop rendered as a small HTML overlay only when the label differs from `zone.id` (or always when provided). Keep it minimal: label = `components?.find((c) => c.id === zone.id)?.label ?? zone.id`.

- [ ] **Step 5: `latest-stats.tsx` units override**

- Props: `units?: Record<string, string>`; inside, `const unit = units?.[stat.key] ?? unitForQualifier(columnQualifier(stat.column))`. (Check the exact internals of `LatestStats` before editing; the KPI cards receive `unit` per stat.)
- Demo page passes the discovered units map:

```tsx
const discoveredUnits = useMemo(() => {
  const map: Record<string, string> = {};
  for (const s of series) {
    const unit = unitForSignal(components, qualifierOf(s.column));
    if (unit) map[s.key] = unit;
  }
  return map;
}, [series, components]);
```

- [ ] **Step 6: Re-render the demo page's KPI strip** — keep `LatestStats` above the grid, now with `units={discoveredUnits}`, fed by the discovered `componentSeries`.

- [ ] **Step 7: Run tests + build + lint**

Run: `cd sample-clients/data-web-client && npm test && bun run build && bun run lint 2>&1 | grep -c 'src/app/demo\|src/components/demo\|src/components/scene'` (expect 0 for our files).

- [ ] **Step 8: Commit**

```bash
git add sample-clients/data-web-client/src/components/demo/vehicle-schematic.tsx sample-clients/data-web-client/src/components/scene/demo-scene.tsx sample-clients/data-web-client/src/components/latest-stats.tsx sample-clients/data-web-client/src/app/demo/page.tsx sample-clients/data-web-client/__tests__/demo/vehicle-schematic.test.tsx
git commit -m "feat(web): discovery-driven scene, schematic and KPI units"
```

---

### Task 8: Docs, rebuild, end-to-end verification

**Files:**
- Modify: `sample-clients/vehicle-client/README.md` (control protocol section — document the `component` field and reply shape)
- Modify: `local-dev/README.md` (demo section: per-component control note)
- Modify: `local-dev/scripts/test-local-flow.sh` (NO changes — verify it still passes untouched)

**Steps:**

- [ ] **Step 1: Document the control protocol** in `sample-clients/vehicle-client/README.md`:

```
### NATS control protocol (control-subject)

Request:  {"action": "start"|"stop"|"status", "component": "<id>"}
          component is optional — omitted = all components (legacy behavior).
Reply:    {"vin","running","published","messageType",
           "components":[{"id","label","enabled","sensors":[{"name","label","unit"}]}]}
Components: battery, cabin, powertrain, chassis (see newControlState in main.go).
The status reply doubles as the dashboard's telemetry discovery endpoint.
```

- [ ] **Step 2: Update `local-dev/README.md`** demo section: one line — "The /demo dashboard controls each telemetry component (battery, cabin, powertrain, chassis) independently via `commands.<VIN>.demo`; components and their sensors are discovered from the simulator's status reply, so new sensors appear in the UI automatically."

- [ ] **Step 3: Rebuild + redeploy local services**

```bash
cd local-dev
docker compose --env-file .env.base-services --env-file .env.sample-services build vehicle-simulator data-web-client
docker compose --env-file .env.base-services --env-file .env.sample-services up -d vehicle-simulator data-web-client
```

Wait for readiness (`curl -sf http://localhost:3000/demo`).

- [ ] **Step 4: Go test suite**

Run: `cd sample-clients/vehicle-client && go test ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Web suite**

Run: `cd sample-clients/data-web-client && npm test && bun run build`
Expected: 133+ existing + new tests PASS; build clean.

- [ ] **Step 6: Browser drive of the dashboard**

1. Open `http://localhost:3000/demo` (headless Chromium), wait for scene + discovery.
2. Assert: component panel shows Battery/Cabin/Powertrain/Chassis with Active badges; chart grid has one chart per signal (≥10 cards); simulator badge shows the discovered VIN.
3. Toggle `Chassis` off → POST succeeds, badge flips to Paused, chassis charts stop gaining points (compare last point timestamps before/after a 6 s wait), other charts keep updating.
4. Toggle `Chassis` on → charts resume.
5. Expand one chart → dialog opens with the full-size chart; close it.
6. `make test` in `local-dev/` still passes (vehicle flow unaffected).

- [ ] **Step 7: Commit**

```bash
git add sample-clients/vehicle-client/README.md local-dev/README.md
git commit -m "docs: per-component telemetry control + discovery dashboard"
```

---

## Self-Review

**Spec coverage:**
- Component Enable/Disable → Task 1 (Go protocol) + Task 5 (panel). ✓
- Active/Paused/Offline states → Task 5 `phaseFor`. ✓
- Dynamic discovery (no hardcoded sensors) → Task 1 status reply (components+sensors) + Task 4 discovery lib; signals appear from live data automatically (existing `shapeRows`/WS already column-agnostic) → Task 6 grid renders any series. ✓
- Every signal has its own real-time graph → Task 6. ✓
- Graphs update only while component enabled; paused keeps history → Go gating (Task 2) + natural freeze + Task 6 paused overlay. ✓
- Configurable history windows → existing TimeRangeSelector retained. ✓
- Layout: control panel / vehicle visualization / live values / chart grid / expandable → Tasks 5-7. ✓
- Data-driven architecture, components own lifecycle → Task 1-2 (simulator owns components), Task 4 (UI renders discovered metadata). ✓
- Performance: memoized chart cards (Task 6), functional state updates + bounded live window (existing hook), per-component publish gating reduces messages. ✓
- Tests: Go unit tests (Tasks 1-2), jest for lib + components (Tasks 3-7). ✓
- Docs → Task 8. ✓

**Known tradeoffs (documented, not blockers):**
- Component→zone geometry (`NODE_POSITIONS`/`COMPONENT_ZONES`) is scene layout, not telemetry metadata — kept static, with id-keyed fallbacks for undiscovered components.
- Units come from the simulator's component registry (source of truth); legacy `unitForQualifier`/`DEMO_COMPONENTS` remain for the device/fleet pages only.
- The vehicle-client publishes `make`/`index` as a separate `telemetry-generic.{VIN}.cabin` message now (was inside `.battery`) — the connector consumes `telemetry-generic.>`, so no backend change needed.

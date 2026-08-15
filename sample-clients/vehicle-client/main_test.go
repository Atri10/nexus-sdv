package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	pbMetrics "github.com/valtech-sdv/vehicle-client/telemetry"
	pbVehicle "github.com/valtech-sdv/vehicle-client/telemetry"
)

func newTestControl(components ...string) (*controlState, *[]map[string]any) {
	var replies []map[string]any
	ctl := newControlState("VIN1001", "both")
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

func TestControlStatusOrderIsStable(t *testing.T) {
	// Regression: components come from a Go map (random iteration); the
	// status reply must keep a deterministic order or the dashboard's grid
	// groups reorder on every poll.
	ctl, replies := newTestControl("chassis", "cabin", "powertrain", "battery")
	var first []string
	for i := 0; i < 25; i++ {
		send(ctl, `{"action":"status"}`)
		r := replyBody(t, replies)
		var ids []string
		for _, c := range r["components"].([]any) {
			ids = append(ids, c.(map[string]any)["id"].(string))
		}
		if i == 0 {
			first = ids
			continue
		}
		if strings.Join(ids, ",") != strings.Join(first, ",") {
			t.Fatalf("status order changed: %v then %v", first, ids)
		}
	}
	want := []string{"battery", "cabin", "powertrain", "chassis"}
	if strings.Join(first, ",") != strings.Join(want, ",") {
		t.Errorf("status order = %v, want %v", first, want)
	}
}

func TestPayloadGatingByComponent(t *testing.T) {
	v := &VehicleClient{VIN: "VIN1001"}
	now := time.Now()
	drive := driveState{enginePower: 100, engineRPM: 2000, fuelLevel: 50, velocity: 10}
	battery := batteryState{voltage: 12.5, current: 10, soc: 80, temp: 25}

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
			if vtd.ENGINE_RPM == nil || *vtd.ENGINE_RPM == 0 {
				t.Errorf("powertrain report wrong: rpm=%v (must be set)", vtd.ENGINE_RPM)
			}
			if vtd.VELOCITY != nil {
				t.Errorf("powertrain report must not carry chassis fields, velocity=%v", *vtd.VELOCITY)
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

func TestPayloadFreeRunPublishesAllComponents(t *testing.T) {
	// Regression: non-control mode must publish every component even though
	// a fresh controlState starts with all components disabled.
	v := &VehicleClient{VIN: "VIN1001"}
	msgs := v.buildPayloads(time.Now(), batteryState{}, driveState{}, "both", 0, func(string) bool { return true })
	// battery + cabin telemetry, 4 per-wheel chassis telemetry messages
	// (TIRE_PRESSURE.{wheel} etc.), powertrain + chassis metrics reports.
	if len(msgs) != 8 {
		t.Fatalf("free-run payloads = %d, want 8 (battery, cabin, 4× chassis wheels, powertrain, chassis)", len(msgs))
	}
	want := map[string]bool{
		"telemetry-generic.VIN1001.battery": true,
		"telemetry-generic.VIN1001.cabin":   true,
		"telemetry-generic.VIN1001.chassis": true, // ×4 — per-wheel tire/brake sensors
		"telemetry.VIN1001":                 true,
	}
	for _, m := range msgs {
		if !want[m.subject] {
			t.Errorf("unexpected subject %q", m.subject)
		}
	}
}

func TestBuildCabinTelemetry(t *testing.T) {
	msg, err := buildCabinTelemetry("VIN1001", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.SensorData) != 4 {
		t.Fatalf("cabin sensors = %d, want 4", len(msg.SensorData))
	}
	want := []string{"make", "model", "year", "firmware"}
	for i, name := range want {
		if msg.SensorData[i].Sensor != name {
			t.Errorf("cabin sensor %d = %q, want %q", i, msg.SensorData[i].Sensor, name)
		}
	}
	if msg.SensorData[1].Value != "SDV-1" || msg.SensorData[3].Value != "1.2.0" {
		t.Errorf("cabin values wrong: %v %v", msg.SensorData[1].Value, msg.SensorData[3].Value)
	}
}

func TestChassisReportCarriesDynamics(t *testing.T) {
	drive := driveState{velocity: 12.3, steeringAngle: -2.5, acceleratorPct: 33, brakePct: 0}
	report, err := buildChassisReport("VIN1001", drive, nil, 0, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var vtd pbVehicle.VehicleTelemetryData
	if err := report.ReportData.UnmarshalTo(&vtd); err != nil {
		t.Fatalf("unpack VehicleTelemetryData: %v", err)
	}
	if vtd.VELOCITY == nil || *vtd.VELOCITY != 12.3 {
		t.Errorf("velocity = %v, want 12.3", vtd.VELOCITY)
	}
	if vtd.TIRE_PRESSURE == nil {
		t.Error("chassis report must carry TIRE_PRESSURE")
	}
	if vtd.TIRE_TEMP == nil {
		t.Error("chassis report must carry TIRE_TEMP")
	}
	if vtd.VehicleDynamics == nil || vtd.VehicleDynamics.SteeringAngleDeg != -2.5 {
		t.Errorf("dynamics missing: %#v", vtd.VehicleDynamics)
	}
	if vtd.ENGINE_RPM != nil {
		t.Errorf("chassis report must not carry powertrain fields, rpm=%v", *vtd.ENGINE_RPM)
	}
}

// TestChassisReportTireTempFromDegradation: when a tires degradation config
// is present the chassis report's TIRE_TEMP must track the TireTempAt curve
// (28 °C ± 8 °C India daily cycle), alongside TIRE_PRESSURE from
// TirePressureAt — the typed path the detector reads as dynamic:TIRE_TEMP.
func TestChassisReportTireTempFromDegradation(t *testing.T) {
	tires := &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 60}
	drive := driveState{velocity: 12.3, steeringAngle: -2.5, acceleratorPct: 33, brakePct: 0}
	ageDays := 15.25
	report, err := buildChassisReport("VIN1001", drive, tires, ageDays, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var vtd pbVehicle.VehicleTelemetryData
	if err := report.ReportData.UnmarshalTo(&vtd); err != nil {
		t.Fatalf("unpack VehicleTelemetryData: %v", err)
	}
	wantTemp := float32(tires.TireTempAt("FL", ageDays))
	if vtd.TIRE_TEMP == nil || math.Abs(float64(*vtd.TIRE_TEMP-wantTemp)) > 0.01 {
		t.Errorf("TIRE_TEMP = %v, want %v (TireTempAt day %v)", vtd.TIRE_TEMP, wantTemp, ageDays)
	}
	wantPressure := float32(tires.TirePressureAt("FL", ageDays))
	if vtd.TIRE_PRESSURE == nil || math.Abs(float64(*vtd.TIRE_PRESSURE-wantPressure)) > 0.01 {
		t.Errorf("TIRE_PRESSURE = %v, want %v (TirePressureAt day %v)", vtd.TIRE_PRESSURE, wantPressure, ageDays)
	}
}

// TestTripPositionAt validates route interpolation, loop wrap and heading.
func TestTripPositionAt(t *testing.T) {
	// Synthetic square loop: 100 m sides starting at (10, 20).
	route := []tripPoint{{10, 20}, {10.001, 20}, {10.001, 20.001}, {10, 20.001}, {10, 20}}
	tr := &trip{pts: route}
	tr.cumDist = make([]float64, len(route))
	for i := 1; i < len(route); i++ {
		tr.cumDist[i] = tr.cumDist[i-1] + distanceM(route[i-1], route[i])
	}
	tr.total = tr.cumDist[len(route)-1]

	lat, lng, h := tr.positionAt(0)
	if lat != 10 || lng != 20 {
		t.Errorf("positionAt(0) = (%v, %v), want (10, 20)", lat, lng)
	}
	if h != 0 {
		t.Errorf("heading at start = %v, want 0 (due north)", h)
	}

	// Halfway along the first segment (~55.6 m north): heading 0, lat 10.0005.
	lat, lng, h = tr.positionAt(tr.cumDist[1] / 2)
	if math.Abs(lat-10.0005) > 1e-9 || math.Abs(lng-20) > 1e-9 {
		t.Errorf("positionAt(half) = (%v, %v), want (10.0005, 20)", lat, lng)
	}
	if h != 0 {
		t.Errorf("heading at half = %v, want 0", h)
	}

	// Heading on the east-bound segment is 90°.
	_, _, h = tr.positionAt(tr.cumDist[1] + 50)
	if math.Abs(h-90) > 1e-6 {
		t.Errorf("heading on east segment = %v, want 90", h)
	}

	// Wrapping: positionAt(total + x) == positionAt(x).
	la1, lo1, _ := tr.positionAt(tr.total + 120)
	la2, lo2, _ := tr.positionAt(120)
	if la1 != la2 || lo1 != lo2 {
		t.Errorf("wrap mismatch: (%v,%v) vs (%v,%v)", la1, lo1, la2, lo2)
	}
}

// TestTripAdvancement: the drive cycle advances tripDist by velocity*dt and
// the position follows the embedded route monotonically.
func TestTripAdvancement(t *testing.T) {
	drive := newDriveState()
	startLat, startLng := drive.lat, drive.lng
	startDist := drive.tripDist

	drive.velocity = 10 // m/s
	driveCycleStep(&drive, 2, 1.0)

	if drive.tripDist <= startDist {
		t.Errorf("tripDist did not advance: %v -> %v", startDist, drive.tripDist)
	}
	if drive.lat == startLat && drive.lng == startLng {
		t.Error("position did not move along the route")
	}
	// Distance travelled ≈ 20 m: lat/lng should have moved ~20 m from start.
	moved := distanceM(tripPoint{startLat, startLng}, tripPoint{drive.lat, drive.lng})
	if moved < 10 || moved > 30 {
		t.Errorf("moved %v m in 2s at 10 m/s, want ~20 m", moved)
	}
	// Heading should be a valid compass value on the real route.
	if drive.headingDeg < 0 || drive.headingDeg >= 360 {
		t.Errorf("heading out of range: %v", drive.headingDeg)
	}
}

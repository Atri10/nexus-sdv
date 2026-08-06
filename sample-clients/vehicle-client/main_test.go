package main

import (
	"bytes"
	"encoding/json"
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
			if vtd.ENGINE_RPM == 0 {
				t.Errorf("powertrain report wrong: rpm=%v (must be set)", vtd.ENGINE_RPM)
			}
			if vtd.VELOCITY != 0 {
				t.Errorf("powertrain report must not carry chassis fields, velocity=%v", vtd.VELOCITY)
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

func TestChassisReportCarriesDynamics(t *testing.T) {
	drive := driveState{velocity: 12.3, steeringAngle: -2.5, acceleratorPct: 33, brakePct: 0}
	report, err := buildChassisReport("VIN1001", drive, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var vtd pbVehicle.VehicleTelemetryData
	if err := report.ReportData.UnmarshalTo(&vtd); err != nil {
		t.Fatalf("unpack VehicleTelemetryData: %v", err)
	}
	if vtd.VELOCITY != 12.3 {
		t.Errorf("velocity = %v, want 12.3", vtd.VELOCITY)
	}
	if vtd.VehicleDynamics == nil || vtd.VehicleDynamics.SteeringAngleDeg != -2.5 {
		t.Errorf("dynamics missing: %#v", vtd.VehicleDynamics)
	}
	if vtd.ENGINE_RPM != 0 {
		t.Errorf("chassis report must not carry powertrain fields, rpm=%v", vtd.ENGINE_RPM)
	}
}

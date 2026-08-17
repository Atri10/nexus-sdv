package main

import (
	"os"
	"testing"
)

func TestIsDeadLocked(t *testing.T) {
	os.Setenv("DEGRADATION_PRESET", "critical")
	defer os.Unsetenv("DEGRADATION_PRESET")
	ctl := newControlState("VIN1001", "both")
	// Fresh vehicle: not dead.
	if ctl.isDeadLocked() {
		t.Fatal("fresh vehicle should not be dead")
	}
	// Battery past horizon: dead.
	ctl.batteryAgeDays = 200 // > critical horizon 60
	if !ctl.isDeadLocked() {
		t.Fatal("battery past horizon should be dead")
	}
	// Tire flat (FL at 1.0): dead even if battery healthy-ish.
	ctl2 := newControlState("VIN1002", "both") // degrading
	ctl2.batteryAgeDays = 0
	if ctl2.isDeadLocked() {
		t.Fatal("fresh degrading vehicle should not be dead")
	}
	// Healthy VIN never dies.
	os.Setenv("DEGRADATION_PRESET", "healthy")
	ctl3 := newControlState("VIN1003", "both")
	ctl3.batteryAgeDays = 500
	if ctl3.isDeadLocked() {
		t.Fatal("healthy vehicle must never be dead")
	}
	os.Unsetenv("DEGRADATION_PRESET")
}

func TestDeathCauseLocked(t *testing.T) {
	t.Setenv("DEGRADATION_PRESET", "critical")

	battery := newControlState("VIN1001", "both")
	battery.batteryAgeDays = 200
	component, wheel := battery.deathCauseLocked()
	if component != "battery" || wheel != "" {
		t.Fatalf("battery death cause = (%q, %q), want (battery, empty)", component, wheel)
	}

	tires := newControlState("VIN1002", "both")
	tires.degradation["battery"].Preset = "healthy"
	tires.batteryAgeDays = 120
	component, wheel = tires.deathCauseLocked()
	if component != "tires" || wheel != "FL" {
		t.Fatalf("tire death cause = (%q, %q), want (tires, FL)", component, wheel)
	}

	state := tires.stateLocked()
	if state["dead_component"] != "" || state["dead_wheel"] != "" {
		t.Fatalf("fresh state exposed stale death cause: component=%v wheel=%v", state["dead_component"], state["dead_wheel"])
	}
	tires.dead = true
	tires.deadComponent = component
	tires.deadWheel = wheel
	state = tires.stateLocked()
	if state["dead_component"] != "tires" || state["dead_wheel"] != "FL" {
		t.Fatalf("state death cause = (%v, %v), want (tires, FL)", state["dead_component"], state["dead_wheel"])
	}
}

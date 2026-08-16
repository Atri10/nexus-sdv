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

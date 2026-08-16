package main

import (
	"os"
	"testing"
)

func TestBatteryDeathVoltageReachesFloor(t *testing.T) {
	os.Setenv("DEGRADATION_PRESET", "critical")
	defer os.Unsetenv("DEGRADATION_PRESET")
	ctl := newControlState("VIN1001", "both")
	deg := ctl.degradationFor("battery")
	// Deep into the death collapse (past horizon + 3 weeks).
	vRest, _, _ := deg.BatteryAt(float64(deg.horizonDays()) + 30)
	clamped := clamp(vRest, 10.5, 14.5)
	// The death arc must reach the detector's 10.5 V floor so health -> 0,
	// not the old 11.0 clamp that froze the meter at ~23%.
	if clamped > 10.7 {
		t.Fatalf("dead battery voltage = %.2f V, want ~10.5 (death floor)", clamped)
	}
	t.Logf("dead battery V_rest = %.2f V (clamped %.2f) -> health %.0f", vRest, clamped, (clamped-10.5)/(12.63-10.5)*100)
}

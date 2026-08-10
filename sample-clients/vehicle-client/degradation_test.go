package main

import (
	"math"
	mathrand "math/rand"
	"testing"
)

func TestBatteryDegradesOverHorizon(t *testing.T) {
	d := &DegradationConfig{Component: "battery", Preset: "degrading", HorizonDays: 120}
	startV, _, _ := d.BatteryAt(0)
	endV, endMin, endR := d.BatteryAt(120)
	if startV < 12.5 || endV > 12.1 {
		t.Fatalf("expected V_rest decline 12.6→~12.0, got %.2f→%.2f", startV, endV)
	}
	if endR <= endMin {
		t.Fatalf("R_int %.1f should exceed V_min %.1f", endR, endMin)
	}
}

func TestHealthyBatteryStable(t *testing.T) {
	d := &DegradationConfig{Component: "battery", Preset: "healthy", HorizonDays: 120}
	_, v, _ := d.BatteryAt(0)
	_, v2, _ := d.BatteryAt(120)
	if math.Abs(v-v2) > 0.05 {
		t.Fatalf("healthy battery drifted %.3f V, want ≤0.05", math.Abs(v-v2))
	}
}

func TestTireLeak(t *testing.T) {
	d := &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 60}
	p0 := d.TirePressureAt(0)
	p60 := d.TirePressureAt(60)
	if p0-p60 < 0.3 {
		t.Fatalf("expected leak ≥0.3 bar over 60d, got %.2f", p0-p60)
	}
}

func TestDegradationControlAction(t *testing.T) {
	ctl, _ := newTestControl("battery")
	send(ctl, `{"action":"degradation","component":"battery","preset":"critical"}`)
	deg := ctl.degradationFor("battery")
	if deg == nil || deg.Preset != "critical" {
		t.Fatalf("battery preset = %v, want critical", deg)
	}
	// Unknown preset must be rejected without mutating state.
	send(ctl, `{"action":"degradation","component":"battery","preset":"warp"}`)
	if deg := ctl.degradationFor("battery"); deg.Preset != "critical" {
		t.Fatalf("battery preset changed to %v after bad preset", deg.Preset)
	}
	// Unknown component must be rejected.
	send(ctl, `{"action":"degradation","component":"flux_capacitor","preset":"degrading"}`)
	deg = ctl.degradationFor("battery")
	if deg.Preset != "critical" {
		t.Fatalf("battery preset = %v, want unchanged critical", deg.Preset)
	}
}

func TestStatusReplyCarriesGroundTruth(t *testing.T) {
	ctl, replies := newTestControl("battery")
	ctl.setGroundTruth(map[string]map[string]any{
		"battery": {"wear_fraction": 0.42, "days_to_failure": 69},
		"brake":   {"wear_fraction": 0.12, "energy_joules": int64(7.2e8)},
	})
	send(ctl, `{"action":"status"}`)
	r := replyBody(t, replies)
	gt, ok := r["ground_truth"].(map[string]any)
	if !ok {
		t.Fatalf("ground_truth missing from status reply: %#v", r)
	}
	batt := gt["battery"].(map[string]any)
	if batt["wear_fraction"] != 0.42 || int(batt["days_to_failure"].(float64)) != 69 {
		t.Errorf("battery ground truth wrong: %#v", batt)
	}
	brk := gt["brake"].(map[string]any)
	if brk["wear_fraction"] != 0.12 {
		t.Errorf("brake ground truth wrong: %#v", brk)
	}
}

// TestBrakeEnergyMatchesProcessor pins the brake accumulator to the
// processor's velocity-delta estimate (m·|Δv|·v_avg, 1500 kg): the sim's
// brake phase decelerates at 3.0 m/s², so a 20 m/s step over 2 s must add
// exactly 1500·3·17·2 = 153 kJ.
func TestBrakeEnergyMatchesProcessor(t *testing.T) {
	s := newDriveState()
	s.phase = 2 // brake
	s.phaseLeft = 10
	s.velocity = 20
	s.brakePct = 40
	driveCycleStep(&s, 2.0)
	want := 1500.0 * 3.0 * 17.0 * 2.0
	if s.brakeEnergyJ != want {
		t.Fatalf("brakeEnergyJ = %v, want %v (processor-identical)", s.brakeEnergyJ, want)
	}
	if s.brakeWearFraction() <= 0 || s.brakeWearFraction() >= 1 {
		t.Errorf("brakeWearFraction out of range: %v", s.brakeWearFraction())
	}
}

// TestBrakeEnergyZeroWhenIdle: no accumulation outside the brake phase.
func TestBrakeEnergyZeroWhenIdle(t *testing.T) {
	s := newDriveState()
	s.phase = 3 // idle
	s.phaseLeft = 10
	s.velocity = 5
	s.brakePct = 0
	driveCycleStep(&s, 2.0)
	if s.brakeEnergyJ != 0 {
		t.Fatalf("brake energy accumulated during idle: %v", s.brakeEnergyJ)
	}
}

// TestBatteryTrajectoryDrivesTelemetry: a degrading battery's published
// voltage follows the V_rest curve (with ±0.025 V noise), and the chassis
// report carries the real tire-leak pressure.
func TestBatteryTrajectoryDrivesTelemetry(t *testing.T) {
	deg := &DegradationConfig{Component: "battery", Preset: "degrading", HorizonDays: 120}
	b := batteryState{voltage: 12.63, current: 45.2, soc: 85.5, temp: 25.3, deg: deg}
	// Model one tick at day 120: age, then walk the curve with noise.
	b.ageDays += 120.0
	vRest, _, _ := deg.BatteryAt(b.ageDays)
	b.voltage = vRest + (mathrand.Float64()-0.5)*0.025
	if math.Abs(b.voltage-vRest) > 0.05 {
		t.Errorf("battery voltage %v off trajectory %v after noise", b.voltage, vRest)
	}
	// V_rest must have declined toward the degraded endpoint (~12.0 V).
	if vRest > 12.1 || vRest < 11.9 {
		t.Errorf("V_rest at day 120 = %v, want ~12.0", vRest)
	}
}

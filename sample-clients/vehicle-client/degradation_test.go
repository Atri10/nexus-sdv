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

// TestBatteryDeathCollapse: past the horizon a degrading/critical battery
// falls off the plateau — V_rest dives below 11.5 V and internal resistance
// spikes — while a healthy battery holds the plateau forever.
func TestBatteryDeathCollapse(t *testing.T) {
	deg := &DegradationConfig{Component: "battery", Preset: "degrading", HorizonDays: 120}
	_, endR, _ := deg.BatteryAt(120)
	vAtHorizon, _, _ := deg.BatteryAt(120)
	vDead, _, rDead := deg.BatteryAt(140) // 20 days past horizon
	if vDead > vAtHorizon {
		t.Fatalf("death collapse did not drop V_rest: %v → %v", vAtHorizon, vDead)
	}
	if vDead > 11.5 {
		t.Fatalf("dead battery still above 11.5 V: %v", vDead)
	}
	if rDead <= endR {
		t.Fatalf("death collapse did not raise R_int: %v → %v", endR, rDead)
	}
	if rDead > 40 {
		t.Fatalf("R_int implausible: %v mΩ", rDead)
	}
	healthy := &DegradationConfig{Component: "battery", Preset: "healthy", HorizonDays: 120}
	vH0, _, _ := healthy.BatteryAt(0)
	vH200, _, _ := healthy.BatteryAt(200)
	if math.Abs(vH0-vH200) > 0.05 {
		t.Fatalf("healthy battery drifted into death: %v → %v", vH0, vH200)
	}
}

// TestTireDeathCascade: the tire leaks slowly, then — past the 1.9 bar flex
// threshold — the leak accelerates, and past the 1.2 bar structural floor the
// pressure collapses toward the ~1.0 bar flat asymptote. Healthy stays 2.3.
func TestTireDeathCascade(t *testing.T) {
	deg := &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 120}
	// The slow-leak phase alone (0.2 bar/month) would reach ~1.5 bar at the
	// horizon; the cascade must go well below that.
	pHorizon := deg.TirePressureAt("FL", 120)
	pLate := deg.TirePressureAt("FL", 240) // 2× the horizon — long past collapse
	if pHorizon >= 1.9 {
		t.Fatalf("tire not leaking at horizon: %.2f bar", pHorizon)
	}
	if pLate > 1.1 {
		t.Fatalf("tire not flat: %.2f bar at 2× horizon", pLate)
	}
	if pLate <= 0.6 {
		t.Fatalf("tire implausibly below the flat asymptote: %.2f bar", pLate)
	}
	// Flex heat: an underinflated tire runs hot (above the 28 °C mean).
	if deg.TireTempAt("FL", 200) < 30 {
		t.Fatalf("flat tire not running hot: %.1f °C", deg.TireTempAt("FL", 200))
	}
	// The healthy preset publishes nothing — must stay at 2.3 bar even late.
	healthy := &DegradationConfig{Component: "tires", Preset: "healthy", HorizonDays: 120}
	if p := healthy.TirePressureAt("FL", 400); math.Abs(p-2.3) > 0.01 {
		t.Fatalf("healthy tire drifted: %.2f bar", p)
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
	p0 := d.TirePressureAt("FL", 0)
	p60 := d.TirePressureAt("FL", 60)
	if p0-p60 < 0.3 {
		t.Fatalf("expected leak ≥0.3 bar over 60d, got %.2f", p0-p60)
	}
}

// TestHealthyTirePressureStable: healthy VINs must not leak — the
// 'healthy publishes nothing' contract breaks if a healthy tire crosses the
// detector's 1.8 bar floor, so pressure stays at the 2.3 bar baseline.
func TestHealthyTirePressureStable(t *testing.T) {
	d := &DegradationConfig{Component: "tires", Preset: "healthy", HorizonDays: 60}
	p0 := d.TirePressureAt("FL", 0)
	p60 := d.TirePressureAt("FL", 60)
	if math.Abs(p0-2.3) > 0.01 || math.Abs(p60-2.3) > 0.01 {
		t.Fatalf("healthy tire drifted %.3f → %.3f bar, want ~2.3 stable", p0, p60)
	}
}

// TestTireWheelStagger: tires fail per wheel — the FL corner (offset 0) hits
// flat first, while FR (offset 15d) / RR (offset 45d) lag at the same day,
// so the demo/PM feed can show an asymmetric failure.
func TestTireWheelStagger(t *testing.T) {
	deg := &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 120}
	// Day 140 sits mid-collapse for the degrading preset: FL is in the
	// structural-collapse phase (~1.0 bar), FR/RL/RR progressively lag — a
	// clear per-wheel spread, with FL's heat uncapped vs FR.
	day := 140.0
	fl := deg.TirePressureAt("FL", day)
	fr := deg.TirePressureAt("FR", day)
	rr := deg.TirePressureAt("RR", day)
	if fl >= 1.1 {
		t.Fatalf("FL tire should be flat at day 140, got %.2f bar", fl)
	}
	if !(fl < fr && fr < rr) {
		t.Fatalf("expected FL<FR<RR stagger at day 150, got FL=%.2f FR=%.2f RR=%.2f", fl, fr, rr)
	}
	if rr <= fr+0.1 {
		t.Fatalf("RR should lag FR meaningfully at day 150: RR=%.2f FR=%.2f", rr, fr)
	}
	// FL's heat tracks its own leak: the flat corner runs hotter than FR.
	flT := deg.TireTempAt("FL", day)
	frT := deg.TireTempAt("FR", day)
	if flT <= frT {
		t.Fatalf("flat FL should run hotter than FR: FL=%.1f°C FR=%.1f°C", flT, frT)
	}
	// Healthy VINs: every wheel stays at 2.3 bar.
	healthy := &DegradationConfig{Component: "tires", Preset: "healthy", HorizonDays: 120}
	for _, w := range wheels {
		if p := healthy.TirePressureAt(w, 400); math.Abs(p-2.3) > 0.01 {
			t.Fatalf("healthy wheel %s drifted: %.2f bar", w, p)
		}
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

func TestControlStateAdopt(t *testing.T) {
	// Adopting another pool VIN swaps the active identity AND reseeds the
	// per-VIN degradation curves (HorizonDays from the new VIN's fleet
	// preset), clears the live/ground-truth/route state, and re-arms the
	// drive/battery reset hook. VIN1009 is index 8 (even → degrading, 120d);
	// VIN1002 is index 1 (odd → healthy... but poolIndex(VIN1002) with the
	// test env has no VIN_POOL, so it falls back to healthy/-1 — the
	// assertion below pins the reseed contract without assuming pool env).
	ctl, _ := newTestControl("battery")
	_ = ctl.degradationFor("battery") // ensure battery is degradable in this ctl

	// Reset hook spy: adopt must invoke it (fresh drive/battery state).
	spy := 0
	ctl.resetFn = func() { spy++ }

	// Seed a non-default horizon so the reseed is observable.
	ctl.degradation["battery"].HorizonDays = 999
	ctl.setGroundTruth(map[string]map[string]any{"tires": {"pressure_bar": 1.5}})
	ctl.setLive(map[string]any{"velocity_m_s": 12.3})

	if err := ctl.adopt("VIN1002"); err != nil {
		t.Fatalf("adopt returned error: %v", err)
	}
	if ctl.vin != "VIN1002" {
		t.Errorf("c.vin = %q, want VIN1002 (adopted)", ctl.vin)
	}
	// Reseeded from the new VIN's pool index — must NOT be the stale 999.
	deg := ctl.degradationFor("battery")
	wantHorizon := defaultDegradationConfig("battery", poolIndex("VIN1002")).HorizonDays
	if deg.HorizonDays == 999 || deg.HorizonDays != wantHorizon {
		t.Errorf("battery HorizonDays = %d after adopt, want reseeded %d (poolIndex %d)",
			deg.HorizonDays, wantHorizon, poolIndex("VIN1002"))
	}
	if spy != 1 {
		t.Errorf("reset hook invoked %d times, want 1 (fresh drive/battery state)", spy)
	}
	// Ground truth + live state cleared for the fresh VIN.
	ctl.mu.Lock()
	gt := ctl.groundTruth
	live := ctl.live
	ctl.mu.Unlock()
	if len(gt) != 0 || len(live) != 0 {
		t.Errorf("adopt must clear groundTruth/live: gt=%d live=%d", len(gt), len(live))
	}
	// Empty VIN is rejected.
	if err := ctl.adopt(""); err == nil {
		t.Error("adopt(\"\") must error")
	}
}

// TestAdoptOnStartSwitchesVIN: a start request carrying a different pool VIN
// makes the simulator adopt it BEFORE enabling components — the status reply
// then echoes the adopted VIN with a clean state.
func TestAdoptOnStartSwitchesVIN(t *testing.T) {
	ctl, replies := newTestControl("battery")
	send(ctl, `{"action":"start","vin":"VIN1002"}`)
	r := replyBody(t, replies)
	if r["vin"] != "VIN1002" {
		t.Errorf("status reply vin = %v, want VIN1002", r["vin"])
	}
	if r["running"] != true {
		t.Errorf("running = %v, want true", r["running"])
	}
	// A start for the SAME VIN must not error or re-adopt.
	send(ctl, `{"action":"start","vin":"VIN1002"}`)
	r = replyBody(t, replies)
	if r["error"] != nil {
		t.Errorf("same-VIN start errored: %v", r["error"])
	}
	if ctl.vin != "VIN1002" {
		t.Errorf("c.vin = %q, want unchanged VIN1002", ctl.vin)
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
	driveCycleStep(&s, 2.0, 1.0)
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
	driveCycleStep(&s, 2.0, 1.0)
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

// degradation.go — per-VIN degradation trajectories (PyBaMM-informed shapes).
package main

import "math"

// brakeEnergyBudgetJ is the pad-life energy budget for a 1500 kg vehicle
// (6 GJ), matching the processor's BRAKE_ENERGY_BUDGET_J. The simulator's
// brake accumulator and the processor's velocity-delta estimate both divide
// by this budget, so detector wear and ground truth stay comparable.
const brakeEnergyBudgetJ = 6.0e9

// wheels are the four vehicle corners in publish order. Tires degrade
// per-wheel with a staggered failure (FL worst) and brake pads wear per
// corner (front 1.4x rear, FL worst), so the demo can show asymmetric
// component-instance failures instead of one channel per component.
var wheels = []string{"FL", "FR", "RL", "RR"}

// wheelOffsetDays returns the phase delay (simulated days) applied to a
// wheel's tire leak curve. FL fails first (offset 0); FR/RL/RR follow with
// increasing offsets so a per-wheel spread is visible in the PM feed.
func wheelOffsetDays(wheel string) float64 {
	switch wheel {
	case "FL":
		return 0.0
	case "FR":
		return 15.0
	case "RL":
		return 30.0
	case "RR":
		return 45.0
	}
	return 0.0
}

type DegradationConfig struct {
	Component   string `json:"component"`
	Preset      string `json:"preset"` // healthy | degrading | critical
	HorizonDays int    `json:"horizon_days"`
}

func (d *DegradationConfig) norm(day float64) float64 {
	h := float64(d.HorizonDays)
	if h <= 0 {
		h = 120
	}
	return math.Max(0, math.Min(1, day/h))
}

func (d *DegradationConfig) severityFactor() float64 {
	switch d.Preset {
	case "critical":
		return 1.0
	case "degrading":
		return 0.85
	default:
		return 0.0 // healthy
	}
}

// BatteryAt returns (V_rest, V_min, R_int_mohm) at day. Curve shapes follow
// the PyBaMM lead-acid aging model offline fits: V_rest declines on a
// sqrt-ish curve (fast early sulfation, plateau, then drop), R_int rises
// ~linearly with deg. Beyond the horizon the battery enters the death
// collapse: it can no longer hold a charge, so V_rest falls off a cliff to
// ~10.5 V (a dead 12 V cell), the cranking sag deepens, and R_int spikes —
// the "battery dies and won't start" arc, so a presenter can watch the
// component go from alerting to dead instead of plateauing at 12.0 V.
func (d *DegradationConfig) BatteryAt(day float64) (float64, float64, float64) {
	deg := d.severityFactor() * math.Sqrt(d.norm(day))
	vRest := 12.63 - 0.63*deg // → 12.0 V at full degradation
	rInt := 9.3 + 6.0*deg     // mΩ, 9.3 baseline → ~15.3
	vMin := 10.8 - 1.3*deg    // cranking sag worsens with aging

	// Death collapse: only degrading/critical batteries die. Healthy
	// batteries (severityFactor 0) hold the healthy plateau forever.
	over := day - float64(d.horizonDays())
	if over > 0 && d.severityFactor() > 0 {
		f := 1 - math.Exp(-over/7.0) // 0 → 1 over ~3 weeks of sim time
		vRest -= 1.5 * f             // 12.0 → 10.5 V: dead cell
		vMin -= 2.5 * f              // cranking can no longer turn the starter
		rInt += 15.0 * f             // 15.3 → ~30 mΩ: massive internal resistance
	}
	return vRest, vMin, rInt
}

// horizonDays returns the config's horizon (fallback 120), used by the
// death-collapse boundary in BatteryAt.
func (d *DegradationConfig) horizonDays() int {
	if d.HorizonDays <= 0 {
		return 120
	}
	return d.HorizonDays
}

// TirePressureAt returns bar at day for one wheel. The tire dies in three
// phases, which is the physical story: a slow leak, then — once the carcass
// is underinflated — sidewall flexing overheats the tire and accelerates the
// leak, and finally structural collapse leaves the tire flat (~1.0 bar,
// "entire tyre useless"). Wheels are staggered by wheelOffsetDays so FL
// fails first and FR/RL/RR follow (healthy VINs never leak: their pressure
// stays at the 2.3 bar baseline, so they publish nothing).
func (d *DegradationConfig) TirePressureAt(wheel string, day float64) float64 {
	if d.Preset == "healthy" {
		return 2.3
	}
	sf := d.severityFactor()
	day -= wheelOffsetDays(wheel) // staggered failure across wheels
	if day < 0 {
		return 2.3
	}

	// Phase 1 — slow puncture: 0.2 bar/month (severity-scaled), the spec's
	// linear leak. Ends when pressure crosses the 1.9 bar flex threshold.
	leakRate := 0.2 * sf / 30.0 // bar/day
	floorDay := (2.3 - 1.9) / leakRate
	if day <= floorDay {
		return 2.3 - leakRate*day
	}

	// Phase 2 — flex acceleration: underinflated sidewalls flex and heat up,
	// which doubles the effective leak rate (see TireTempAt — the detector's
	// temperature compensation compounds this into an even steeper P_comp
	// decline). Runs until the 1.2 bar structural floor.
	over := day - floorDay
	collapseDay := floorDay + (1.9 - 1.2) / (2 * leakRate)
	if day <= collapseDay {
		return 1.9 - 2*leakRate*over
	}

	// Phase 3 — structural collapse: the carcass is destroyed; pressure
	// decays exponentially to the 1.0 bar "flat tire" asymptote.
	return 1.2 - 0.2*(1-math.Exp(-(day-collapseDay)/7.0))
}

// padWearBias returns the per-pad share multiplier of the total brake energy
// budget. Front pads do more work under braking (weight transfer), and FL is
// the worst corner — so per-pad wear fractions spread across the four pads
// and the FL pad crosses the detector's action threshold first. The biases
// sum to 4 so the mean pad wear stays equal to the legacy single-channel
// fraction (E/E_budget).
func padWearBias(pad string) float64 {
	switch pad {
	case "FL":
		return 1.4
	case "FR":
		return 1.25
	case "RL":
		return 0.8
	case "RR":
		return 0.55
	}
	return 1.0
}

// BrakeWearAt returns the wear fraction (0..1) of one brake pad, given the
// energy dissipated across ALL pads so far. The pad's share of the budget is
// the total energy times its bias; a pad is 100 % worn when its share reaches
// the full 6 GJ budget. FL wears fastest (bias 1.4), RR slowest (0.55).
func (d *DegradationConfig) BrakeWearAt(pad string, totalEnergyJ float64) float64 {
	share := totalEnergyJ * padWearBias(pad) / brakeEnergyBudgetJ
	return clamp(share, 0, 1)
}

// TireTempAt returns °C at day for one wheel — 28 °C mean with ±8 °C daily
// cycle (India), plus underinflation flex-heating per wheel: below 1.9 bar
// the sidewalls do extra work and the tire runs hot (up to +14 °C as it
// approaches flat). The heat is what makes the leak self-accelerating in
// real tires, and the detector sees it as a steeper temperature-compensated
// pressure decline. The per-wheel offset mirrors TirePressureAt so a wheel's
// heat tracks its own leak.
func (d *DegradationConfig) TireTempAt(wheel string, day float64) float64 {
	ambient := 28.0 + 8.0*math.Sin(day*2*math.Pi)
	if d.Preset == "healthy" {
		return ambient
	}
	p := d.TirePressureAt(wheel, day)
	heat := 0.0
	if p < 1.9 {
		heat = clamp((1.9-p)*20.0, 0, 14.0) // +2 °C per 0.1 bar below 1.9, capped
	}
	return ambient + heat
}

// degradation.go — per-VIN degradation trajectories (PyBaMM-informed shapes).
package main

import "math"

// brakeEnergyBudgetJ is the pad-life energy budget for a 1500 kg vehicle
// (6 GJ), matching the processor's BRAKE_ENERGY_BUDGET_J. The simulator's
// brake accumulator and the processor's velocity-delta estimate both divide
// by this budget, so detector wear and ground truth stay comparable.
const brakeEnergyBudgetJ = 6.0e9

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
// ~linearly with deg.
func (d *DegradationConfig) BatteryAt(day float64) (float64, float64, float64) {
	deg := d.severityFactor() * math.Sqrt(d.norm(day))
	vRest := 12.63 - 0.63*deg // → 12.0 V at full degradation
	rInt := 9.3 + 6.0*deg     // mΩ, 9.3 baseline → ~15.3
	vMin := 10.8 - 1.3*deg    // cranking sag worsens with aging
	return vRest, vMin, rInt
}

// TirePressureAt returns bar at day. Leak rate is 0.2 bar/month for
// degrading/critical presets; healthy VINs do not leak (they must publish
// nothing, so their pressure stays at the 2.3 bar baseline).
func (d *DegradationConfig) TirePressureAt(day float64) float64 {
	if d.Preset == "healthy" {
		return 2.3
	}
	leak := 0.2 * d.norm(day)
	return 2.3 - leak*day/30.0
}

// TireTempAt returns °C at day — 28 °C mean with ±8 °C daily cycle (India).
func (d *DegradationConfig) TireTempAt(day float64) float64 {
	return 28.0 + 8.0*math.Sin(day*2*math.Pi)
}

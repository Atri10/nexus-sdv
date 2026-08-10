package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestGroundTruthLabelsWriterSchema pins the JSONL schema the offline
// evaluator's collect_ground_truth() consumes (see
// sample-services/predictive-maintenance/scripts/evaluate_detectors.py):
// one JSON object per line with {vin, t_epoch, battery:{wear_fraction,
// days_to_failure}, brake:{wear_fraction, energy_joules},
// tires:{pressure_bar, temp_c}} — the same fields the status reply's
// ground_truth carries.
func TestGroundTruthLabelsWriterSchema(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sim-ground-truth.jsonl")

	client := &VehicleClient{
		VIN:               "VIN1001",
		groundTruthLabels: path,
	}
	deg := &DegradationConfig{Component: "battery", Preset: "degrading", HorizonDays: 120}
	battery := batteryState{voltage: 12.3, current: 45.2, soc: 80.0, temp: 25.3, deg: deg, ageDays: 30}
	drive := newDriveState()
	drive.brakeEnergyJ = 7.2e8
	client.tiresDeg = &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 120}
	client.batteryAgeDays = 30

	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	client.writeGroundTruthLabels(now, battery, drive)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("labels file not written: %v", err)
	}
	var rec struct {
		Vin     string  `json:"vin"`
		TEpoch  float64 `json:"t_epoch"`
		Battery struct {
			WearFraction float64 `json:"wear_fraction"`
			DaysToFail   int     `json:"days_to_failure"`
		} `json:"battery"`
		Brake struct {
			WearFraction float64 `json:"wear_fraction"`
			EnergyJoules int64   `json:"energy_joules"`
		} `json:"brake"`
		Tires struct {
			PressureBar float64 `json:"pressure_bar"`
			TempC       float64 `json:"temp_c"`
		} `json:"tires"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("labels line is not valid JSON: %v\n%s", err, raw)
	}
	if rec.Vin != "VIN1001" {
		t.Errorf("vin = %q, want VIN1001", rec.Vin)
	}
	if rec.TEpoch != float64(now.UnixNano())/1e9 {
		t.Errorf("t_epoch = %v, want %v", rec.TEpoch, float64(now.UnixNano())/1e9)
	}
	// Battery wear tracks the V_rest decline; a degrading battery at day 30
	// must be partway between healthy (12.63 V) and degraded (12.0 V).
	if rec.Battery.WearFraction <= 0 || rec.Battery.WearFraction >= 1 {
		t.Errorf("battery wear_fraction = %v, want in (0,1)", rec.Battery.WearFraction)
	}
	if rec.Battery.DaysToFail <= 0 || rec.Battery.DaysToFail > 120 {
		t.Errorf("battery days_to_failure = %v, want in (0,120]", rec.Battery.DaysToFail)
	}
	if rec.Brake.WearFraction <= 0 || rec.Brake.WearFraction >= 1 {
		t.Errorf("brake wear_fraction = %v, want in (0,1)", rec.Brake.WearFraction)
	}
	if rec.Brake.EnergyJoules != 7.2e8 {
		t.Errorf("brake energy_joules = %v, want 720000000", rec.Brake.EnergyJoules)
	}
	if rec.Tires.PressureBar <= 1.8 || rec.Tires.PressureBar > 2.3 {
		t.Errorf("tires pressure_bar = %v, want in (1.8, 2.3]", rec.Tires.PressureBar)
	}
	if rec.Tires.TempC < 20 || rec.Tires.TempC > 36 {
		t.Errorf("tires temp_c = %v, want ~28 ± 8", rec.Tires.TempC)
	}
}

// TestGroundTruthLabelsWriterAppends: the writer appends one line per call
// (per VIN per tick) and never truncates — a soak's labels must survive
// simulator restarts.
func TestGroundTruthLabelsWriterAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sim-ground-truth.jsonl")

	client := &VehicleClient{VIN: "VIN1001", groundTruthLabels: path}
	deg := &DegradationConfig{Component: "battery", Preset: "critical", HorizonDays: 60}
	battery := batteryState{voltage: 12.2, current: 45.2, soc: 70.0, temp: 25.3, deg: deg, ageDays: 10}
	drive := newDriveState()

	now := time.Now()
	client.writeGroundTruthLabels(now, battery, drive)
	client.writeGroundTruthLabels(now.Add(2*time.Second), battery, drive)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("labels file not written: %v", err)
	}
	lines := 0
	for _, line := range raw {
		if line == '\n' {
			lines++
		}
	}
	if lines != 2 {
		t.Fatalf("expected 2 label lines, got %d\n%s", lines, raw)
	}
}

// TestGroundTruthLabelsWriterDisabled: no labels path configured → no file
// is created and no error is raised.
func TestGroundTruthLabelsWriterDisabled(t *testing.T) {
	dir := t.TempDir()
	client := &VehicleClient{VIN: "VIN1001"} // groundTruthLabels empty
	deg := &DegradationConfig{Component: "battery", Preset: "critical", HorizonDays: 60}
	battery := batteryState{voltage: 12.2, current: 45.2, soc: 70.0, temp: 25.3, deg: deg, ageDays: 10}
	drive := newDriveState()

	client.writeGroundTruthLabels(time.Now(), battery, drive)

	if _, err := os.Stat(filepath.Join(dir, "sim-ground-truth.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("labels file created despite empty path (err=%v)", err)
	}
}

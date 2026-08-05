package main

import (
	"strings"
	"testing"
)

func TestClamp(t *testing.T) {
	if got := clamp(150, 0, 100); got != 100 {
		t.Fatalf("clamp(150,0,100) = %v, want 100", got)
	}
	if got := clamp(-5, 0, 100); got != 0 {
		t.Fatalf("clamp(-5,0,100) = %v, want 0", got)
	}
	if got := clamp(42, 0, 100); got != 42 {
		t.Fatalf("clamp(42,0,100) = %v, want 42", got)
	}
}

func TestRandomVinFromPool(t *testing.T) {
	pool := []string{"VIN1001", "VIN1002", "VIN1003"}
	seen := map[string]bool{}
	for i := 0; i < 60; i++ {
		v := randomVinFromPool(pool)
		if !contains(pool, v) {
			t.Fatalf("randomVinFromPool returned %q, not in pool", v)
		}
		seen[v] = true
	}
	if len(seen) < 2 {
		t.Fatalf("randomVinFromPool not random: only saw %v", seen)
	}
}

func TestDriveCycleBounds(t *testing.T) {
	s := newDriveState()
	for i := 0; i < 2000; i++ {
		driveCycleStep(&s, 1.0)
		if s.velocity < 0 || s.velocity > 200 {
			t.Fatalf("velocity out of bounds: %v", s.velocity)
		}
		if s.acceleratorPct < 0 || s.acceleratorPct > 100 {
			t.Fatalf("accelerator out of bounds: %v", s.acceleratorPct)
		}
		if s.brakePct < 0 || s.brakePct > 100 {
			t.Fatalf("brake out of bounds: %v", s.brakePct)
		}
		if s.engineRPM < 0 || s.engineRPM > 6000 {
			t.Fatalf("rpm out of bounds: %v", s.engineRPM)
		}
	}
}

func TestGpsWalkBounds(t *testing.T) {
	lat, lng := 12.9716, 77.5946
	for i := 0; i < 1000; i++ {
		lat, lng = gpsWalk(lat, lng)
		if lat < 12.9 || lat > 13.05 || lng < 77.5 || lng > 77.7 {
			t.Fatalf("gps out of bounds: %v, %v", lat, lng)
		}
	}
}

func TestDriveCycleProfileVariety(t *testing.T) {
	s := newDriveState()
	velocities := map[float64]bool{}
	for i := 0; i < 3000; i++ {
		driveCycleStep(&s, 1.0)
		velocities[s.velocity] = true
	}
	if len(velocities) < 10 {
		t.Fatalf("drive cycle too static: %d distinct velocities", len(velocities))
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestPoolEnvParsing(t *testing.T) {
	pool := parseVINPool("VIN1001,VIN1002 VIN1003")
	if len(pool) != 3 || !strings.HasPrefix(pool[0], "VIN10") {
		t.Fatalf("parseVINPool = %v", pool)
	}
}

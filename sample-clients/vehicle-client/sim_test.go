package main

import (
	"math"
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
		driveCycleStep(&s, 1.0, 1.0)
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

func TestTripRouteBounds(t *testing.T) {
	// The GPS position follows the embedded street loop — it must stay
	// inside the route's bounding box for the whole simulation.
	minLat, maxLat, minLng, maxLng := 90.0, -90.0, 180.0, -180.0
	for _, p := range tripRoute {
		minLat = math.Min(minLat, p.lat)
		maxLat = math.Max(maxLat, p.lat)
		minLng = math.Min(minLng, p.lng)
		maxLng = math.Max(maxLng, p.lng)
	}
	s := newDriveState()
	for i := 0; i < 2000; i++ {
		driveCycleStep(&s, 2.0, 1.0)
		if s.lat < minLat-0.001 || s.lat > maxLat+0.001 || s.lng < minLng-0.001 || s.lng > maxLng+0.001 {
			t.Fatalf("position off the trip route: %v, %v (route bbox %.5f..%.5f, %.5f..%.5f)",
				s.lat, s.lng, minLat, maxLat, minLng, maxLng)
		}
		if s.headingDeg < 0 || s.headingDeg >= 360 {
			t.Fatalf("heading out of range: %v", s.headingDeg)
		}
	}
}

func TestDriveCycleProfileVariety(t *testing.T) {
	s := newDriveState()
	velocities := map[float64]bool{}
	for i := 0; i < 3000; i++ {
		driveCycleStep(&s, 1.0, 1.0)
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

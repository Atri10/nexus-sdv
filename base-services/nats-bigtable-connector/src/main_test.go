package main

import "testing"

func TestMetricFormat(t *testing.T) {
	cases := map[string]string{
		"GPS_LATITUDE":  "%.6f",
		"GPS_LONGITUDE": "%.6f",
		"VELOCITY":      "%.2f",
		"battery.soc":   "%.2f",
		"":              "%.2f",
	}
	for qualifier, want := range cases {
		if got := metricFormat(qualifier); got != want {
			t.Errorf("metricFormat(%q) = %q, want %q", qualifier, got, want)
		}
	}
}

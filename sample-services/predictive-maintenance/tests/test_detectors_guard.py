# Regression guard: detect_battery must not touch resting-voltage math when
# rest is empty (fresh VIN first start). Cranking is an independent trigger.
from predictive_maintenance.core.detectors import detect_battery

def test_battery_empty_rest_with_cranking_critical():
    # rest==[] (fresh VIN) but a cranking event exists → must not IndexError;
    # V_min 9.0 < 9.5 → cranking-only critical.
    r = detect_battery([], [(1.0, 9.0, 180.0)])
    assert r.severity == "critical"
    assert r.health_score < 30
    assert "cranking" in r.explanation

def test_battery_empty_rest_no_cranking_healthy():
    # rest==[] and no cranking → early guard: healthy 100, no crash.
    r = detect_battery([], [])
    assert r.severity == "healthy" and r.health_score == 100

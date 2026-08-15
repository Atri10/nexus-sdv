# tests/test_detectors.py
from predictive_maintenance.core.detectors import (
    detect_battery, detect_brake, detect_tires, DetectorResult,
    BATTERY_ADVISORY_V, BATTERY_ACTION_V,
)

def test_battery_healthy_no_alert():
    # Resting voltage pinned at 12.6 V over 40 days, no cranking events.
    rest = [(i * 86400.0, 12.6) for i in range(40)]
    r = detect_battery(rest, [])
    assert r.severity == "healthy" and r.health_score >= 70

def test_battery_degrading_slope_advisory():
    # 12.60 → 12.40 V linear over 30 days → slope -0.0067 V/day < -0.5 mV/day.
    rest = [(i * 86400.0, 12.60 - i * 0.20 / 30.0) for i in range(30)]
    r = detect_battery(rest, [])
    assert r.severity == "advisory"
    assert "12.4" in r.explanation  # evidence surfaced in the template

def test_battery_cranking_critical():
    rest = [(0.0, 12.6)] * 1
    crank = [(1.0, 9.0, 180.0)]  # V_min 9.0 < 9.5 → critical
    r = detect_battery(rest, crank)
    assert r.severity == "critical"

def test_battery_insufficient_data_no_alert():
    rest = [(i * 86400.0, 12.6) for i in range(3)]  # < 5 samples
    r = detect_battery(rest, [])
    assert r.severity == "healthy" and r.health_score == 100  # no signal, no alert

def test_brake_wear_advisory_action():
    assert detect_brake(0.85).severity == "advisory"
    assert detect_brake(0.95).severity == "action"
    assert detect_brake(0.5).severity == "healthy"

def test_tires_slow_leak_slope_advisory():
    # 2.30 → 1.75 bar over 30 days: the continuous health meter maps pressure
    # onto 0-100 (2.3 bar = 100, 0.9 bar = 0) so 1.75 bar ≈ 61, but the
    # severity comes from the THRESHOLD rules — below the 1.8 bar floor is an
    # action alert even at score 61. The old step rule froze the meter at 20;
    # now the meter tracks the flat-death arc while alerts stay thresholded.
    import math
    days = 30
    samples = [(i * 86400.0, 2.30 - 0.55 * i / days, 303.15) for i in range(days)]
    r = detect_tires(samples, recommended_bar=2.3)
    assert r.severity == "action"  # 1.75 < 1.8 floor → action alert
    assert 50 <= r.health_score < 70  # continuous meter ≈ 61
    # A truly flat tire (1.0 bar) must score near zero and be critical.
    flat = [(i * 86400.0, 2.30 - 1.3 * i / days, 303.15) for i in range(days)]
    rf = detect_tires(flat, recommended_bar=2.3)
    assert rf.health_score < 15
    assert rf.severity == "critical"

def test_tires_temp_compensation():
    # Same absolute pressure at hot temp must compensate to a higher P_comp.
    r = detect_tires([(0.0, 2.3, 303.15)], recommended_bar=2.3)
    assert r.health_score > 0


def test_tires_per_wheel():
    """Per-wheel tires: FL collapses 2.3 -> 1.0 bar (flat, critical) while FR
    holds steady at 2.3 (healthy); evidence carries the wheel label."""
    import math
    days = 30
    fl = [(i * 86400.0, 2.3 - 1.3 * i / days, 303.15) for i in range(days)]
    fr = [(i * 86400.0, 2.3, 303.15) for i in range(days)]
    rfl = detect_tires(fl, recommended_bar=2.3, wheel="FL")
    rfr = detect_tires(fr, recommended_bar=2.3, wheel="FR")
    assert rfl.severity == "critical"
    assert rfl.health_score < 15
    assert rfl.evidence.get("wheel") == "FL"
    assert rfr.severity == "healthy"
    assert rfr.evidence.get("wheel") == "FR"


def test_brake_per_pad():
    """Per-pad brakes: pad FL worn to 0.95 (> 0.9 action threshold) while pad
    FR is fresh (0.1, healthy); evidence carries the pad label."""
    rfl = detect_brake(0.95, pad="FL")
    rfr = detect_brake(0.1, pad="FR")
    assert rfl.severity == "action"
    assert rfl.evidence.get("pad") == "FL"
    assert rfl.evidence["wear_fraction"] == "0.950"
    assert rfr.severity == "healthy"
    assert rfr.evidence.get("pad") == "FR"


def test_detectors_omit_wheel_pad_when_not_given():
    """Back-compat: without wheel/pad the evidence dict carries no such key
    (legacy single-channel calls keep the old shape)."""
    assert "wheel" not in detect_tires(
        [(i * 86400.0, 2.3, 303.15) for i in range(15)]
    ).evidence
    assert "pad" not in detect_brake(0.5).evidence

# Regression guard: cranking-only evidence (fresh VIN first start) must be a
# str->str map so PmMessage.SerializeToString() does not crash on a bool value.
from predictive_maintenance.core.detectors import detect_battery
from predictive_maintenance.model.pm_message import PmMessage

def test_detect_battery_cranking_only_serializes():
    # rest==[] + cranking event → evidence is {"cranking_only": "true", ...};
    # building a PmMessage from it and serializing must not raise.
    r = detect_battery([], [(1.0, 9.0, 180.0)])
    assert r.evidence["cranking_only"] == "true"
    m = PmMessage(vin="VIN-FRESH", component="battery", health_score=r.health_score,
                  severity=r.severity, evidence=r.evidence,
                  explanation=r.explanation, timestamp="2026-08-10T00:00:00Z")
    raw = m.SerializeToString()  # must not raise
    assert raw
    m2 = PmMessage().parse(raw)
    assert m2.evidence["cranking_only"] == "true"

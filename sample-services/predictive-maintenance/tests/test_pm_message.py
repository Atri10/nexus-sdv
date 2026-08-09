from predictive_maintenance.model.pm_message import PmMessage

def test_pm_message_roundtrip():
    m = PmMessage(vin="VIN1001", component="battery", health_score=62,
                  severity="advisory", evidence={"ewma_voltage": "12.38"},
                  explanation="Resting voltage 12.38 V.", timestamp="2026-08-09T00:00:00Z")
    raw = m.SerializeToString()
    m2 = PmMessage().parse(raw)
    assert m2.vin == "VIN1001" and m2.health_score == 62 and m2.evidence["ewma_voltage"] == "12.38"

import json

import pytest

from predictive_maintenance.config.config import Settings
from predictive_maintenance.config.logging import logger, normalize_log_level, setup_logging


@pytest.mark.parametrize("value, expected", [
    ("debug", "debug"),
    (" DEBUG ", "debug"),
    ("INFO", "info"),
    ("critical", "critical"),
])
def test_normalize_log_level_accepts_supported_values(value, expected):
    assert normalize_log_level(value) == expected


def test_settings_rejects_unknown_log_level():
    with pytest.raises(ValueError, match="LOG_LEVEL must be one of"):
        Settings(log_level="verbose")


def test_startup_config_redacts_nats_password():
    configured = Settings(nats_password="do-not-log")

    assert configured.public_dict()["nats_password"] == "[REDACTED]"


def test_setup_logging_filters_below_threshold_and_emits_json(capsys):
    setup_logging("warning")

    logger.info("hidden_info_event")
    logger.warning("visible_warning_event", vehicle_id="VIN1001")

    lines = [line for line in capsys.readouterr().out.splitlines() if line]
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["event"] == "visible_warning_event"
    assert record["level"] == "warning"
    assert record["vehicle_id"] == "VIN1001"
    assert "timestamp" in record

    # Keep the process-wide logger usable for the remaining test modules.
    setup_logging("info")

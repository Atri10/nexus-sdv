"""Unit tests for the offline evaluator's metric math (Task 9).

The evaluator itself is a one-off tool that needs a live data-api, so these
tests pin the parts that are pure logic: alert-vs-ground-truth classification
(precision/recall/lead-time) and the labels-file parsing. Imported via the
project's src path (same layout as tests/test_processor.py).
"""
from datetime import datetime, timezone
from pathlib import Path

import pytest

from scripts.evaluate_detectors import (
    _first_alert_epoch,
    collect_ground_truth,
    compute_metrics,
    run_detectors_for_vin,
    write_validation_json,
)

COMPONENTS = ("battery", "brake", "tires")


def _alerts(*entries):
    out = []
    for e in entries:
        out.append(
            {
                "vin": e[0],
                "component": e[1],
                "health_score": 40,
                "severity": "advisory",
                "timestamp": "2026-08-10T00:00:00Z",
                "t_epoch": e[2],
                "evidence": {},
                "explanation": "",
            }
        )
    return out


def _labels(path, lines):
    p = Path(path)
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(p)


# --- compute_metrics ---------------------------------------------------------

def test_all_true_positives_perfect_scores():
    """Every alert matches a failed VIN before failure → precision=recall=1."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
        "V2": {"battery": {"t_failure_epoch": 20 * 86400, "failed": True}},
    }
    alerts = _alerts(
        ("V1", "battery", 5 * 86400),
        ("V2", "battery", 15 * 86400),
    )
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 1.0
    assert m["battery"]["recall"] == 1.0
    assert m["battery"]["mean_lead_days"] == 5.0  # (10-5) and (20-15) days


def test_missed_failures_lower_recall():
    """Failure with no alert → recall drops; precision stays 1 (no FPs)."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
        "V2": {"battery": {"t_failure_epoch": 20 * 86400, "failed": True}},
    }
    alerts = _alerts(("V1", "battery", 5 * 86400))
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 1.0
    assert m["battery"]["recall"] == 0.5
    assert m["battery"]["mean_lead_days"] == 5.0


def test_alert_after_failure_is_false_positive():
    """Alert AFTER the failure epoch is a FP, not a TP."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
    }
    alerts = _alerts(("V1", "battery", 15 * 86400))
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 0.0
    assert m["battery"]["recall"] == 0.0
    assert m["battery"]["mean_lead_days"] == 0.0


def test_alert_on_healthy_vin_is_false_positive():
    """Healthy VIN (no failure label) that alerts → FP; recall unaffected."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
        "V2": {},  # healthy — no labels for any component
    }
    alerts = _alerts(
        ("V1", "battery", 5 * 86400),
        ("V2", "battery", 3 * 86400),
    )
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 0.5
    assert m["battery"]["recall"] == 1.0


def test_first_alert_wins_for_lead_time():
    """Only the FIRST alert per vin+component contributes to lead time."""
    gt = {
        "V1": {"tires": {"t_failure_epoch": 30 * 86400, "failed": True}},
    }
    alerts = _alerts(
        ("V1", "tires", 20 * 86400),   # first — 10 days lead
        ("V1", "tires", 25 * 86400),   # later — ignored
    )
    m = compute_metrics(alerts, set(), gt)
    assert m["tires"]["precision"] == 1.0
    assert m["tires"]["mean_lead_days"] == 10.0


def test_unmodeled_component_reports_none():
    """Component with no failures AND no alerts → None (card shows a dash),
    not a meaningless 1.0."""
    gt = {"V1": {"battery": {"t_failure_epoch": 1, "failed": True}}}
    m = compute_metrics([], set(), gt)
    assert m["battery"] is not None
    assert m["brake"] is None
    assert m["tires"] is None


def test_components_are_independent():
    """Brake FPs must not affect battery scores and vice versa."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
        "V2": {"battery": {"t_failure_epoch": 20 * 86400, "failed": True}},
        "V3": {"brake": {"t_failure_epoch": 50 * 86400, "failed": True}},
    }
    alerts = _alerts(
        ("V1", "battery", 5 * 86400),
        ("V2", "battery", 15 * 86400),
        ("V3", "brake", 49 * 86400),  # brake TP — must not touch battery
    )
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 1.0
    assert m["brake"]["precision"] == 1.0  # independent score


# --- collect_ground_truth ----------------------------------------------------

def test_ground_truth_parses_failure_epochs(tmp_path):
    """Labels file: battery fails at days_to_failure<=0, tires at the 1.8 bar
    floor, brake at the 6 GJ budget — failure epoch = the tick that crossed."""
    labels = _labels(
        tmp_path / "labels.jsonl",
        [
            '{"vin": "V1", "t_epoch": 1000.0, "battery": {"wear_fraction": 0.42, "days_to_failure": 3}}',
            '{"vin": "V1", "t_epoch": 2000.0, "battery": {"wear_fraction": 0.99, "days_to_failure": 0}}',
            '{"vin": "V2", "t_epoch": 3000.0, "tires": {"pressure_bar": 1.75, "temp_c": 30.0}}',
            '{"vin": "V3", "t_epoch": 4000.0, "brake": {"wear_fraction": 0.99, "energy_joules": 6000000000}}',
            '{"vin": "V4", "t_epoch": 5000.0, "battery": {"wear_fraction": 0.1, "days_to_failure": 50}}',
        ],
    )
    gt = collect_ground_truth(labels)
    assert gt["V1"]["battery"]["failed"] is True
    assert gt["V1"]["battery"]["t_failure_epoch"] == 2000.0
    assert gt["V2"]["tires"]["failed"] is True
    assert gt["V3"]["brake"]["failed"] is True
    assert "battery" not in gt["V4"]  # never failed within the window


def test_ground_truth_missing_file_is_empty():
    assert collect_ground_truth("/nonexistent/labels.jsonl") == {}


def test_ground_truth_skips_unlabeled_vins():
    """A VIN with telemetry but no failure label must not be treated as
    failed — the evaluator can only score against labels it saw."""
    gt = {"V1": {"battery": {"t_failure_epoch": 1, "failed": True}}}
    m = compute_metrics([], set(), gt)
    assert m["battery"]["recall"] == 0.0  # V1 failed, nothing alerted
    assert m["battery"]["precision"] == 0.0  # no alerts at all


# --- write_validation_json ---------------------------------------------------

def test_write_validation_json_task8_shape(tmp_path):
    """Output JSON matches the /pm card's PmValidationData shape (Task 8)."""
    out = tmp_path / "pm-validation.json"
    metrics = {
        "battery": {"precision": 1.0, "recall": 0.5, "mean_lead_days": 5.0},
        "brake": None,
        "tires": {"precision": 0.8, "recall": 0.7, "mean_lead_days": 12.0},
    }
    write_validation_json(metrics, out, simulated_vins=3)
    data = json_load(out)
    assert data["generated"] == datetime.now(timezone.utc).strftime("%Y-%m-%d")
    assert data["simulated_vins"] == 3
    assert set(data["components"]) == {"battery", "brake", "tires"}
    assert data["components"]["battery"] == metrics["battery"]
    assert data["components"]["brake"] is None
    assert data["components"]["tires"]["mean_lead_days"] == 12.0


def json_load(path: Path):
    import json
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --- regression: fix round 1 (reviewer findings) -----------------------------

def test_run_detectors_multi_vin_does_not_crash():
    """Reviewer finding 1: one grpclib Channel + asyncio.run() per VIN dies on
    the second VIN ("Future attached to a different loop"). The fix drives all
    VINs through ONE event loop with the channel constructed inside it, so a
    multi-VIN run must score every VIN, not silently score only the first."""
    import asyncio

    from grpclib.server import Server

    from predictive_maintenance.client.generated.dataapi.v1 import (
        TelemetryDataApiBase,
        TelemetryPoint,
    )

    class FakeDataApi(TelemetryDataApiBase):
        def __init__(self, points_by_vin):
            self._points = points_by_vin

        async def get_telemetry_data(self, request):
            for point in self._points.get(request.vehicle_id, []):
                yield point

    def _battery_point(day: int, volts: str):
        return TelemetryPoint(
            timestamp=datetime(2026, 8, day, tzinfo=timezone.utc),
            values={
                "dynamic:battery.voltage": bytes(f'"{volts}"', "utf-8"),
                "dynamic:battery.temp": b'"30.0"',
            },
        )

    # 3 VINs, each with 5 resting-voltage samples at 12.10 V → all three
    # alert (critical battery). The OLD code scored only the first VIN.
    points = {
        f"VIN{i}": [_battery_point(1 + j, "12.10") for j in range(5)]
        for i in range(1, 4)
    }

    # Serve the fake data-api from a background thread with its own event
    # loop so it stays alive while the evaluator's loop connects to it.
    import threading

    server_loop = asyncio.new_event_loop()
    thread = threading.Thread(target=server_loop.run_forever, daemon=True)
    thread.start()

    async def start_server():
        server = Server([FakeDataApi(points)])
        await server.start("127.0.0.1", 0)
        return server

    server = asyncio.run_coroutine_threadsafe(start_server(), server_loop).result()
    port = server._server.sockets[0].getsockname()[1]
    try:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        end = datetime(2026, 8, 10, tzinfo=timezone.utc)
        alerts, active_pairs, scored = run_detectors_for_vin(
            ["VIN1", "VIN2", "VIN3"],
            ["dynamic:battery.voltage", "dynamic:battery.temp"],
            start,
            end,
            data_api_addr=f"127.0.0.1:{port}",
        )
    finally:
        server_loop.call_soon_threadsafe(server.close)
        server_loop.call_soon_threadsafe(server_loop.stop)
        thread.join()

    battery_alerts = [a for a in alerts if a["component"] == "battery"]
    assert scored == 3  # every VIN scored — not just the first
    assert {a["vin"] for a in battery_alerts} == {"VIN1", "VIN2", "VIN3"}
    assert {p[0] for p in active_pairs if p[1] == "battery"} == {
        "VIN1", "VIN2", "VIN3"
    }


def test_first_alert_epoch_brake_never_none():
    """Reviewer finding 2: _first_alert_epoch had no brake branch → None →
    TypeError in compute_metrics. The brake branch must return the window
    start (docstring promise) so t_epoch is never None for an existing
    alert."""
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    # results: brake detector fired; rest/tires empty (no per-sample data).
    epoch = _first_alert_epoch(
        {"brake": object()}, "brake", [], [], window_start=start
    )
    assert epoch == start.timestamp()


def test_compute_metrics_brake_alert_does_not_crash():
    """Reviewer finding 2 end-to-end: a brake alert (with its t_epoch from the
    window-start fallback) against a brake failure label must not raise
    TypeError, and must count as a TP."""
    gt = {
        "V1": {"brake": {"t_failure_epoch": 50 * 86400, "failed": True}},
    }
    alerts = _alerts(("V1", "brake", 10 * 86400))  # alert well before failure
    m = compute_metrics(alerts, set(), gt)
    assert m["brake"]["precision"] == 1.0
    assert m["brake"]["recall"] == 1.0
    assert m["brake"]["mean_lead_days"] == 40.0  # (50-10) days


def test_compute_metrics_handles_none_epoch_alert():
    """Defensive: even if some caller ever produced an alert with t_epoch
    None, compute_metrics must not crash — the alert is a FP (no provable
    lead time) rather than a TypeError."""
    gt = {
        "V1": {"battery": {"t_failure_epoch": 10 * 86400, "failed": True}},
    }
    alerts = _alerts(("V1", "battery", None))
    m = compute_metrics(alerts, set(), gt)
    assert m["battery"]["precision"] == 0.0
    assert m["battery"]["recall"] == 0.0


def test_first_alert_epoch_battery_uses_compensated_voltage():
    """Reviewer finding 3: the battery first-alert epoch compared the RAW
    voltage against the advisory threshold, but detection uses the
    temperature-compensated voltage. A sample that is only under the
    threshold after compensation must count (and vice versa)."""
    # V_comp = V - BATTERY_BETA*(T - 30); BATTERY_BETA = -0.011 V/°C.
    # T = 20 °C → BATTERY_BETA*(-10) = +0.11 → comp = 12.30 - 0.11 = 12.19 V,
    # BELOW the 12.4 V advisory threshold: the detector WOULD alert, so the
    # epoch must be returned (the OLD raw comparison said 12.30 > 12.4 → None).
    rest_cold = [(1000.0, 12.30, 20.0)]
    assert (
        _first_alert_epoch({"battery": object()}, "battery", rest_cold, [])
        == 1000.0
    )
    # T = 40 °C → BATTERY_BETA*(10) = -0.11 → comp = 12.40 + 0.11 = 12.51 V,
    # ABOVE the advisory threshold: the detector would NOT alert, so no
    # first-alert epoch (the OLD raw comparison said 12.40 <= 12.4 → epoch).
    rest_hot = [(2000.0, 12.40, 40.0)]
    assert (
        _first_alert_epoch({"battery": object()}, "battery", rest_hot, [])
        is None
    )

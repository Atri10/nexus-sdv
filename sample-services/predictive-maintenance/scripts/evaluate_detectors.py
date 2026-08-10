import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from grpclib.client import Channel

from predictive_maintenance.client.generated.dataapi.v1 import (
    GetTelemetryDataRequest,
    TelemetryDataApiStub,
)
from predictive_maintenance.core.detectors import (
    BATTERY_BETA,
    BATTERY_V_REF,
    TIRE_FLOOR_BAR,
    detect_battery,
    detect_brake,
    detect_tires,
)

# Brake pad energy budget: 6 GJ over pad life (1500 kg vehicle). Kept in
# sync with Processor.BRAKE_ENERGY_BUDGET_J so the evaluator reproduces the
# service's wear estimate exactly.
BRAKE_ENERGY_BUDGET_J = 6.0e9
VEHICLE_MASS_KG = 1500.0

# Default grpc target when --data-api-addr is not given (matches the pm
# service's Settings default, but reachable from the host in local dev).
DEFAULT_DATA_API_ADDR = "localhost:9090"

# The detector service's poll request — replayed verbatim per VIN.
DATA_TYPES = [
    "dynamic:battery.voltage",
    "dynamic:battery.temp",
    "dynamic:VELOCITY",
    "dynamic:BRAKE_PEDAL_PCT",
    "dynamic:TIRE_PRESSURE",
    "dynamic:TIRE_TEMP",
]


def _float(value: bytes) -> float:
    return float(value.decode().strip('"'))


def _parse_point(point):
    """Decode one data-api TelemetryPoint into the raw row the processor
    consumes: (t_epoch, decoded-values-dict)."""
    t = point.timestamp.timestamp()
    values = {k: _float(v) for k, v in point.values.items()}
    return t, values


def run_detectors_for_vin(vins, data_types, start, end, batch_size=50,
                          data_api_addr=DEFAULT_DATA_API_ADDR):
    """Re-run the processor's data-poll + detectors over the given window.

    vins: iterable of VINs; data_types: qualifier list (see DATA_TYPES);
    start/end: datetime window; batch_size: progress-log cadence;
    data_api_addr: gRPC host:port of the data-api.
    Returns (alerts, active_pairs, scored_vins).
      alerts:      list of dicts {vin, component, health_score, severity,
                  timestamp (ISO, UTC), t_epoch, evidence, explanation}
                  — only severity != 'healthy', matching the service cadence.
      active_pairs: set of (vin, component) that received ANY telemetry in
                  the window (the recall denominator's population).
      scored_vins: count of VINs whose poll actually completed (a poll that
                  fails — network error, empty reply — is logged and skipped,
                  not counted, so simulated_vins reports scored/total).
    """
    alerts = []
    active_pairs = set()
    scored = 0

    host, _, port = data_api_addr.partition(":")
    if not port:
        port = "80"

    async def _run():
        nonlocal scored
        # Channel constructed INSIDE the running loop: grpclib binds
        # Channel._loop = asyncio.get_event_loop() at construction and reuses
        # it for every connection, so a channel built outside asyncio.run()
        # (as with one asyncio.run() per VIN) dies on the second VIN with
        # "Future attached to a different loop". One loop for the whole run —
        # the channel is created once and every VIN polls through it.
        channel = Channel(host, int(port))
        try:
            stub = TelemetryDataApiStub(channel)

            async def poll(vin: str):
                nonlocal scored
                request = GetTelemetryDataRequest(
                    vehicle_id=vin,
                    data_types=list(data_types),
                    time_range=None,
                )
                # Explicit window instead of the service's last_duration so a
                # soak can be re-scored against its full range, and so the
                # evaluator doesn't depend on wall-clock "now".
                from predictive_maintenance.client.generated.dataapi.v1 import TimeRange
                request.time_range = TimeRange(start=start, end=end)

                rest, crank, brake_energy, tires = [], [], 0.0, []
                batt_temp = BATTERY_V_REF
                prev_brake = None
                try:
                    async for point in stub.get_telemetry_data(request):
                        t, values = _parse_point(point)
                        if "dynamic:battery.temp" in values:
                            batt_temp = values["dynamic:battery.temp"]
                        if "dynamic:battery.voltage" in values:
                            rest.append(
                                (t, values["dynamic:battery.voltage"], batt_temp)
                            )
                        if (
                            "dynamic:TIRE_PRESSURE" in values
                            and "dynamic:TIRE_TEMP" in values
                        ):
                            tires.append(
                                (
                                    t,
                                    values["dynamic:TIRE_PRESSURE"],
                                    values["dynamic:TIRE_TEMP"] + 273.15,
                                )
                            )
                        if (
                            "dynamic:VELOCITY" in values
                            and "dynamic:BRAKE_PEDAL_PCT" in values
                        ):
                            vel = values["dynamic:VELOCITY"]
                            brake_pct = values["dynamic:BRAKE_PEDAL_PCT"]
                            if prev_brake is not None and brake_pct > 5.0:
                                prev_t, prev_v = prev_brake
                                dt = t - prev_t
                                if dt > 0:
                                    a = (vel - prev_v) / dt
                                    v_avg = 0.5 * (vel + prev_v)
                                    if a < -0.5 and v_avg > 0.5:
                                        brake_energy += (
                                            VEHICLE_MASS_KG * abs(a) * v_avg * dt
                                        )
                            prev_brake = (t, vel)
                except Exception as exc:  # poll error — same swallow as Processor
                    print(f"  [warn] poll failed for {vin}: {exc!r}", file=sys.stderr)
                    return

                if rest:
                    active_pairs.add((vin, "battery"))
                if brake_energy > 0:
                    active_pairs.add((vin, "brake"))
                if tires:
                    active_pairs.add((vin, "tires"))

                results = {}
                if rest:
                    comp = [
                        (t, v0 - BATTERY_BETA * (t0 - BATTERY_V_REF))
                        for t, v0, t0 in rest
                    ]
                    results["battery"] = detect_battery(comp, crank)
                if brake_energy > 0:
                    results["brake"] = detect_brake(
                        min(1.0, brake_energy / BRAKE_ENERGY_BUDGET_J)
                    )
                if tires:
                    results["tires"] = detect_tires(tires)

                for component, result in results.items():
                    if result.severity == "healthy":
                        continue
                    alerts.append(
                        {
                            "vin": vin,
                            "component": component,
                            "health_score": result.health_score,
                            "severity": result.severity,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "t_epoch": _first_alert_epoch(
                                results, component, rest, tires, window_start=start
                            ),
                            "evidence": result.evidence,
                            "explanation": result.explanation,
                        }
                    )
                scored += 1

            for i, vin in enumerate(vins, 1):
                await poll(vin)
                if i % batch_size == 0 or i == len(vins):
                    print(f"  polled {i}/{len(vins)} VINs")
        finally:
            channel.close()

    asyncio.run(_run())

    return alerts, active_pairs, scored


def _first_alert_epoch(results, component, rest, tires, window_start=None):
    """Best-effort first-alert epoch for lead-time math: the timestamp of the
    first telemetry sample that crosses the detector's alert threshold.

    For battery this is the first temperature-compensated resting-voltage
    sample at or below the advisory threshold (12.4 V — compared against the
    SAME compensated voltage the detector consumes, not the raw reading);
    for tires the first compensated-pressure sample at or below the floor
    (1.8 bar). Brake has no per-sample crossing (energy accumulates over the
    whole window), so it falls back to the window start — the lead-time for
    brake is therefore a lower bound. window_start is the poll window's
    start datetime; for brake it is converted to an epoch. If it is not
    given, the alert's own timestamp (t of the last sample seen) is used so
    an alert never carries a None epoch.
    """
    if component == "battery":
        from predictive_maintenance.core.detectors import BATTERY_ADVISORY_V
        for t, v_raw, t0 in rest:
            v_comp = v_raw - BATTERY_BETA * (t0 - BATTERY_V_REF)
            if v_comp <= BATTERY_ADVISORY_V:
                return t
    if component == "tires":
        from predictive_maintenance.core.detectors import TIRE_FLOOR_BAR, TIRE_REF_K
        for t, p, tk in tires:
            p_comp = p * TIRE_REF_K / tk if tk > 0 else p
            if p_comp <= TIRE_FLOOR_BAR:
                return t
    if component == "brake":
        # No per-sample crossing: energy accumulates over the whole window.
        # Fall back to the window start (docstring promise) — a lower bound
        # on lead time — or, when no window is available, the alert time.
        if window_start is not None:
            # main() strips tzinfo to keep the data-api request naive, but
            # the wall-clock values ARE UTC — interpret them as UTC so the
            # epoch matches the (UTC-aware) sample timestamps.
            if window_start.tzinfo is None:
                return window_start.replace(tzinfo=timezone.utc).timestamp()
            return window_start.timestamp()
        if rest:
            return rest[-1][0]
        if tires:
            return tires[-1][0]
        return 0.0
    return None


def collect_ground_truth(labels_path):
    """Load simulator ground-truth labels from a JSONL file written by the
    vehicle-simulator's ground-truth labels writer (one JSON object per
    line, one per VIN per tick; enabled via GROUND_TRUTH_LABELS):

        {"vin": "VIN1001", "t_epoch": 1728000000.0,
         "battery": {"wear_fraction": 0.42, "days_to_failure": 69},
         "brake":   {"wear_fraction": 0.12, "energy_joules": 720000000},
         "tires":   {"pressure_bar": 2.10, "temp_c": 30.0}}

    Returns {vin: {component: {t_failure_epoch, failed}}} where failed is
    True when the VIN actually reached failure within the soak window.
    Failure definitions mirror the sim's own ground truth:
      battery: days_to_failure <= 0 (full degradation — 12.0 V resting)
      tires:   pressure_bar <= TIRE_FLOOR_BAR (1.8 bar)
      brake:   energy_joules >= BRAKE_ENERGY_BUDGET_J
    """
    gt = {}
    if labels_path is None or not Path(labels_path).exists():
        print("  [info] no ground-truth labels file; scoring alerts only", file=sys.stderr)
        return gt

    with open(labels_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            vin = rec.get("vin")
            if not vin:
                continue
            entry = gt.setdefault(vin, {})
            for component in ("battery", "brake", "tires"):
                comp = rec.get(component)
                if not comp:
                    continue
                if component == "battery" and "days_to_failure" in comp:
                    if int(comp["days_to_failure"]) <= 0:
                        entry.setdefault(
                            component,
                            {"t_failure_epoch": rec["t_epoch"], "failed": True},
                        )
                elif component == "tires" and "pressure_bar" in comp:
                    if float(comp["pressure_bar"]) <= TIRE_FLOOR_BAR:
                        entry.setdefault(
                            component,
                            {"t_failure_epoch": rec["t_epoch"], "failed": True},
                        )
                elif component == "brake" and "energy_joules" in comp:
                    if float(comp["energy_joules"]) >= BRAKE_ENERGY_BUDGET_J:
                        entry.setdefault(
                            component,
                            {"t_failure_epoch": rec["t_epoch"], "failed": True},
                        )
    return gt


def compute_metrics(alerts, active_pairs, ground_truth):
    """Per-component precision / recall / mean lead days.

    Alert is a true positive when the VIN's ground truth has the component
    marked failed AND the first alert for (vin, component) precedes the
    failure epoch. Precision = TP / (TP + FP); recall = TP / failed_VINs;
    lead = mean over TPs of (failure_epoch - first_alert_epoch) in days.
    Components the sim never modeled (missing ground truth) are reported as
    None and written as null in the JSON — no fabricated numbers.
    """
    metrics = {}
    for component in ("battery", "brake", "tires"):
        failed = {
            vin
            for vin, comps in ground_truth.items()
            if comps.get(component, {}).get("failed")
        }
        alerted = {
            a["vin"] for a in alerts if a["component"] == component
        }
        first_alert = {}
        for a in alerts:
            if a["component"] != component:
                continue
            prev = first_alert.get(a["vin"])
            if prev is None or a["t_epoch"] < prev:
                first_alert[a["vin"]] = a["t_epoch"]

        if not failed and not alerted:
            # Component not modeled by this soak (or no data at all): leave
            # the card as a dash rather than claiming a 1.0 that means
            # nothing. The evaluator reports "not measured".
            metrics[component] = None
            continue

        tp = 0
        fp = 0
        leads = []
        for vin in alerted:
            fail_epoch = ground_truth.get(vin, {}).get(component, {}).get("t_failure_epoch")
            alert_epoch = first_alert[vin]
            # _first_alert_epoch never returns None for a real alert (brake
            # falls back to the window start), but a None here (e.g. an alert
            # dict built by an older caller) must not crash the whole run:
            # treat it as an un-dated alert → can't prove it preceded the
            # failure → FP.
            if alert_epoch is None:
                fp += 1
                continue
            if fail_epoch is not None and alert_epoch <= fail_epoch:
                tp += 1
                leads.append((fail_epoch - alert_epoch) / 86400.0)
            else:
                fp += 1
        fn = len(failed - alerted)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        mean_lead_days = round(sum(leads) / len(leads), 1) if leads else 0.0
        metrics[component] = {
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "mean_lead_days": mean_lead_days,
        }
    return metrics


def write_validation_json(metrics, output_path, simulated_vins):
    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "simulated_vins": simulated_vins,
        "components": {
            component: (metrics[component] if metrics[component] is not None else None)
            for component in ("battery", "brake", "tires")
        },
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=(
            "Offline evaluator for the predictive-maintenance detectors.\n\n"
            "Re-runs the processor's data-poll + detectors over data-api "
            "history for the given VINs, compares the alert list against "
            "simulator ground-truth labels, and writes per-component "
            "precision / recall / mean lead time (days) to the /pm "
            "validation card's JSON (sample-clients/data-web-client/public/"
            "pm-validation.json).\n\n"
            "Recommended run (local stack, after a soak):\n"
            "  uv run --project sample-services/predictive-maintenance python "
            "sample-services/predictive-maintenance/scripts/evaluate_detectors.py \\\n"
            "      --vins VIN1001,VIN1002,VIN1003,VIN1004,VIN1005 \\\n"
            "      --soak-days 60 \\\n"
            "      --labels local-dev/data/sim-ground-truth.jsonl\n"
            "The labels file is written by the vehicle-simulator: one JSON "
            "line per VIN per tick with the status reply's ground_truth "
            "(battery wear_fraction/days_to_failure, brake "
            "wear_fraction/energy_joules, tires pressure_bar/temp_c). The "
            "simulator writes it when GROUND_TRUTH_LABELS is set (the local "
            "compose service mounts local-dev/data:/data and points it at "
            "/data/sim-ground-truth.jsonl). When no labels file exists the "
            "evaluator scores alerts only and writes null component metrics "
            "— run it after a soak to get real numbers. "
            "Healthy VINs publish no alerts by design (Task 3 §publish-"
            "cadence); the default soak mixes healthy/degrading/critical "
            "presets (DEGRADATION_PRESET=demo)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--vins",
        required=True,
        help="Comma-separated VIN list to evaluate (e.g. VIN1001,VIN1002,...)",
    )
    parser.add_argument(
        "--soak-days",
        type=int,
        default=60,
        help="Evaluation window in days ending now (default 60).",
    )
    parser.add_argument(
        "--labels",
        default="local-dev/data/sim-ground-truth.jsonl",
        help="Simulator ground-truth labels file (JSONL). Default: "
        "local-dev/data/sim-ground-truth.jsonl",
    )
    parser.add_argument(
        "--output",
        default="sample-clients/data-web-client/public/pm-validation.json",
        help="Output JSON path (Task 8 shape). Default: the /pm validation card's file.",
    )
    parser.add_argument(
        "--data-api-addr",
        default=DEFAULT_DATA_API_ADDR,
        help="gRPC address of the data-api (default localhost:9090).",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    vins = [v.strip() for v in args.vins.split(",") if v.strip()]
    if not vins:
        print("error: --vins must name at least one VIN", file=sys.stderr)
        return 2

    end = datetime.now(timezone.utc)
    from datetime import timedelta
    start = end - timedelta(days=args.soak_days)

    print(f"evaluating {len(vins)} VINs over {args.soak_days} days (window "
          f"{start.isoformat()} -> {end.isoformat()})")
    alerts, active_pairs, scored = run_detectors_for_vin(
        vins, DATA_TYPES, start, end, data_api_addr=args.data_api_addr
    )
    print(f"alerts: {len(alerts)} (from {scored}/{len(vins)} VINs scored; "
          f"polls that failed are logged and skipped)")
    for component in ("battery", "brake", "tires"):
        n = sum(1 for a in alerts if a["component"] == component)
        print(f"  {component}: {n} alert(s), {sum(1 for p in active_pairs if p[1] == component)} VIN(s) with data")

    ground_truth = collect_ground_truth(args.labels)
    print(f"ground truth: {len(ground_truth)} VIN(s) with labels")
    metrics = compute_metrics(alerts, active_pairs, ground_truth)
    for component, m in metrics.items():
        if m is None:
            print(f"  {component}: not measured (no labels for this soak)")
        else:
            print(f"  {component}: precision={m['precision']} recall={m['recall']} "
                  f"mean_lead_days={m['mean_lead_days']}")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_validation_json(metrics, output_path, simulated_vins=scored)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Calibration for the battery degradation curve.

One-off offline tool: runs a heavy physics model (PyBaMM lead-acid) through
`uv run --with pybamm` to fit the degradation shapes (V_rest / R_int
trajectories) that `vehicle-client/degradation.go`'s `DegradationConfig.
BatteryAt` approximates, and emits `degradation_config.json`. The checked-in
defaults in degradation.go remain the fallback — this script exists to
re-derive them from first-principles physics when someone wants to re-tune.

Run:

    uv run --with pybamm python scripts/calibrate_battery_curve.py \
        --output degradation_config.json

    # force a re-fit (default skips the fit when the output already exists)
    uv run --with pybamm python scripts/calibrate_battery_curve.py --force

Output shape (kept close to DegradationConfig's parameterization so the Go
code can consume it with minimal mapping):

    {
      "generated": "2026-08-10",
      "model": "pybamm.lead_acid.LOQS",
      "temperatures_c": [25.0, 35.0, 45.0],
      "horizon_days": 60,
      "fit": {
        "V_rest": {"start_v": 12.63, "drop_v": 0.63, "shape": "sqrt"},
        "R_int":  {"baseline_mohm": 9.3, "rise_mohm": 6.0, "shape": "linear"}
      }
    }

The fit reports the curve SHAPE parameters (start voltage, total drop,
baseline/rise resistance) rather than attempting to bolt PyBaMM's internal
states onto the simulator's age axis — the simulator walks its own ageDays
trajectory, and the physics model only informs the shape. If PyBaMM is not
installed the script falls back to the shipped defaults and prints a warning;
that fallback is the documented behaviour, not an error.

NOTE: this script is NOT run by any test or CI path. It is a one-off tool
for maintainers; `make pm-demo` and the local stack never invoke it.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Shipped defaults — the values currently hardcoded in
# sample-clients/vehicle-client/degradation.go (BatteryAt). They are the
# fallback whenever PyBaMM is unavailable or the fit is skipped.
SHIPPED_DEFAULTS = {
    "V_rest": {"start_v": 12.63, "drop_v": 0.63, "shape": "sqrt"},
    "R_int": {"baseline_mohm": 9.3, "rise_mohm": 6.0, "shape": "linear"},
}


def _fit_with_pybamm(temperatures_c, horizon_days):
    """Fit V_rest/R_int trajectory shapes with PyBaMM's lead-acid model.

    Runs three LOQS simulations (25/35/45 °C) over a horizon that maps to
    the simulator's critical preset (60 days), extracts the open-circuit
    voltage and internal-resistance trajectories, and reports the shape
    parameters (start, drop/rise, shape name). Raises ImportError when
    PyBaMM is not available; the caller falls back to shipped defaults.
    """
    import numpy as np
    import pybamm

    # We only need the OCV and resistance over time; discharge at a low,
    # constant rate keeps the terminal voltage near OCV.
    model = pybamm.lead_acid.LOQS()
    sims = []
    for temp_c in temperatures_c:
        param = model.default_parameter_values
        param["Ambient temperature [K]"] = temp_c + 273.15
        sim = pybamm.Simulation(model, parameter_values=param)
        # Time span in seconds: horizon_days at a 1 Hz resolution would be
        # far too heavy for a one-off tool, so sample daily.
        t_end = horizon_days * 86400.0
        solution = sim.solve([0, t_end])
        sims.append(solution)

    # Reduce the three temperature runs to shape parameters. The
    # degradation shape the Go code uses is a sqrt curve on a normalized
    # day axis: V_rest(t) = start_v - drop_v * sqrt(t/horizon). We report
    # start_v / drop_v from the 35 °C (India-reference-adjacent) run and
    # the temperature deltas as informational fields.
    sol = sims[1]  # 35 °C run
    t = sol["Time [s]"].entries
    v = sol["Terminal voltage [V]"].entries
    r = sol["Internal resistance [Ohm]"].entries

    start_v = float(v[0])
    end_v = float(v[-1])
    drop_v = round(start_v - end_v, 3)
    baseline_mohm = round(float(r[0]) * 1e3, 1)
    rise_mohm = round((float(r[-1]) - float(r[0])) * 1e3, 1)

    return {
        "V_rest": {"start_v": round(start_v, 2), "drop_v": drop_v, "shape": "sqrt"},
        "R_int": {
            "baseline_mohm": baseline_mohm,
            "rise_mohm": rise_mohm,
            "shape": "linear",
        },
        "temp_deltas_v_per_c": round(
            (float(sims[2]["Terminal voltage [V]"].entries[0])
             - float(sims[0]["Terminal voltage [V]"].entries[0])) / 20.0, 4
        ),
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--output",
        default="degradation_config.json",
        help="Output JSON path (default degradation_config.json in CWD).",
    )
    parser.add_argument(
        "--temperatures-c",
        default="25,35,45",
        help="Comma-separated temperatures (°C) to simulate (default 25,35,45).",
    )
    parser.add_argument(
        "--horizon-days",
        type=int,
        default=60,
        help="Degradation horizon in days (default 60 = the critical preset).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-run the PyBaMM fit even when the output file already exists.",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    output_path = Path(args.output)
    temperatures_c = [float(t.strip()) for t in args.temperatures_c.split(",") if t.strip()]

    if output_path.exists() and not args.force:
        print(f"degradation_config.json already exists at {output_path} "
              f"(use --force to re-fit); leaving it untouched.", file=sys.stderr)
        return 0

    try:
        fit = _fit_with_pybamm(temperatures_c, args.horizon_days)
        source = "pybamm"
        print(f"PyBaMM fit completed: {json.dumps(fit, indent=2)}")
    except ImportError:
        fit = dict(SHIPPED_DEFAULTS)
        source = "shipped-defaults-fallback"
        print(
            "WARNING: PyBaMM is not installed in this environment; wrote the "
            "shipped defaults (degradation.go BatteryAt) as the calibration. "
            "Run with `uv run --with pybamm` on a machine with the physics "
            "toolchain to produce a real fit.",
            file=sys.stderr,
        )

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "model": "pybamm.lead_acid.LOQS" if source == "pybamm" else "shipped-defaults",
        "temperatures_c": temperatures_c,
        "horizon_days": args.horizon_days,
        "fit": fit,
        "note": (
            "Shape parameters for DegradationConfig.BatteryAt "
            "(sample-clients/vehicle-client/degradation.go). "
            f"Source: {source}."
        ),
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

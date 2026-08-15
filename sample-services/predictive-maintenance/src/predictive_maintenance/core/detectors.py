# src/predictive_maintenance/core/detectors.py
"""Deterministic predictive-maintenance detectors (no ML, no LLM).

Thresholds are the values locked in by docs/superpowers/research/
2026-08-05-predictive-maintenance-algorithms.md and the design spec.
Temperature reference is India-calibrated: 30 °C (spec §3).
"""
from dataclasses import dataclass, field

BATTERY_EWMA_ALPHA = 0.1
BATTERY_V_REF = 30.0          # °C, India-calibrated reference
BATTERY_BETA = -0.011         # V/°C lead-acid temp coefficient
BATTERY_ADVISORY_V = 12.4     # ~75% SoC on the OCV curve
BATTERY_ACTION_V = 12.2
BATTERY_SLOPE_MV = -0.5       # mV/day, sustained 30-day slope
CRANK_VMIN = 9.5              # V during cranking
CRANK_R_MULT = 1.5            # x baseline internal resistance
CRANK_BASELINE_MOHM = 9.3     # mΩ default baseline (spec worked example)
BRAKE_ADVISORY = 0.8          # wear fraction
BRAKE_ACTION = 0.9
TIRE_REF_K = 293.15           # 20 °C
TIRE_SLOPE_BAR_M = -0.15      # bar/month
TIRE_FLOOR_BAR = 1.8

SEVERITIES = ("healthy", "advisory", "action", "critical")


@dataclass
class DetectorResult:
    health_score: int
    severity: str
    evidence: dict = field(default_factory=dict)
    explanation: str = ""


def _band(score: int) -> str:
    if score >= 70:
        return "healthy"
    if score >= 50:
        return "advisory"
    return "action"


def detect_battery(rest, crank, baseline_r_int_mohm=None):
    """rest: list[(t_epoch, V_rest)]; crank: list[(t, V_min, I_crank)]."""
    if len(rest) < 5 and not crank:
        return DetectorResult(100, "healthy", {}, "Insufficient data — no alert.")
    score = 100
    reasons = []
    ewma = slope_mv_day = None
    if rest:
        # Temperature-compensate each resting reading against 30 °C reference.
        comp = [v for _, v in rest]  # V already compensated by caller; see note
        ewma = comp[0]
        for v in comp[1:]:
            ewma = (1 - BATTERY_EWMA_ALPHA) * ewma + BATTERY_EWMA_ALPHA * v
        # 30-day slope via linear least squares (mV/day).
        n = len(rest)
        xs = [t / 86400.0 for t, _ in rest]
        mean_x, mean_y = sum(xs) / n, sum(comp) / n
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, comp))
        den = sum((x - mean_x) ** 2 for x in xs)
        slope_mv_day = (num / den * 1000.0) if den else 0.0
        # Continuous health: map the EWMA resting voltage onto a 0-100 scale
        # (12.63 V healthy = 100, 10.5 V dead = 0). This makes the health
        # meter track the actual death arc — a battery collapsing 11.3 → 10.5 V
        # reads 30 → 0, not a frozen 25 — which is what a viewer expects from
        # "battery dying". The threshold rules below then only ADD penalty
        # (slope / cranking), they never override the voltage-derived score.
        score = min(score, round(max(0, min(100, (ewma - 10.5) / (12.63 - 10.5) * 100))))
        if ewma < BATTERY_ACTION_V:
            reasons.append(f"EWMA {ewma:.2f} V < {BATTERY_ACTION_V} V (action)")
        elif ewma < BATTERY_ADVISORY_V:
            reasons.append(f"EWMA {ewma:.2f} V < {BATTERY_ADVISORY_V} V (advisory)")
        if slope_mv_day < BATTERY_SLOPE_MV:
            score = min(score, 55)
            reasons.append(f"slope {slope_mv_day:.2f} mV/day < {BATTERY_SLOPE_MV} mV/day")
    # Cranking signature.
    baseline = baseline_r_int_mohm or CRANK_BASELINE_MOHM
    for _, vmin, ic in crank:
        if vmin < CRANK_VMIN:
            score = min(score, 20)
            reasons.append(f"cranking V_min {vmin:.1f} V < {CRANK_VMIN} V")
        if ic > 0:
            r_int = (12.6 - vmin) / ic * 1000.0  # mΩ
            if r_int > CRANK_R_MULT * baseline:
                score = min(score, 30)
                reasons.append(f"R_int {r_int:.1f} mΩ > {CRANK_R_MULT:.1f}x baseline")
    score = max(0, score)
    # Severity comes from the THRESHOLD rules (the alert signal), not the
    # continuous meter: a battery at 12.10 V is below the 12.2 V action line
    # and must alert as action even though its continuous score (~75) still
    # reads high. The score is the degradation *meter*; the threshold rules
    # are the *alerts*. Very low voltage (< 11.8 V) escalates to critical.
    if ewma is not None and ewma < BATTERY_ACTION_V - 0.4:
        severity = "critical"
    elif ewma is not None and ewma < BATTERY_ACTION_V:
        severity = "action"
    elif ewma is not None and ewma < BATTERY_ADVISORY_V:
        severity = "advisory"
    elif any(vmin < CRANK_VMIN for _, vmin, _ in crank):
        severity = "critical"
    else:
        severity = _band(score)
    if ewma is None:
        evidence = {"cranking_only": "true",
                    "threshold_advisory": f"{BATTERY_ADVISORY_V}", "threshold_action": f"{BATTERY_ACTION_V}"}
        explanation = "; ".join(reasons) or "No anomaly."
    else:
        evidence = {"ewma_voltage": f"{ewma:.2f}", "slope_mv_day": f"{slope_mv_day:.2f}",
                    "threshold_advisory": f"{BATTERY_ADVISORY_V}", "threshold_action": f"{BATTERY_ACTION_V}"}
        explanation = ("Resting voltage {:.2f} V, drifting {:.2f} mV/day (advisory threshold {} V).".format(
            ewma, slope_mv_day, BATTERY_ADVISORY_V)) or ("; ".join(reasons) or "No anomaly.")
    return DetectorResult(
        health_score=score,
        severity=severity,
        evidence=evidence,
        explanation=explanation,
    )


def detect_brake(wear_fraction, wear_rate_per_km=None, pad=None):
    score = max(0, min(100, round(100 * (1 - wear_fraction))))
    if wear_fraction > BRAKE_ACTION:
        severity, msg = "action", f"Wear index {wear_fraction:.0%} > {BRAKE_ACTION:.0%}"
    elif wear_fraction > BRAKE_ADVISORY:
        severity, msg = "advisory", f"Wear index {wear_fraction:.0%} > {BRAKE_ADVISORY:.0%}"
    else:
        severity, msg = "healthy", f"Wear index {wear_fraction:.0%}"
    evidence = {"wear_fraction": f"{wear_fraction:.3f}",
                "wear_rate_per_km": f"{wear_rate_per_km or 0:.6f}"}
    if pad:
        evidence["pad"] = pad
    return DetectorResult(score, severity, evidence,
                          f"{msg} of the calibrated pad budget.")


def detect_tires(samples, recommended_bar=2.3, wheel=None):
    """samples: list[(t_epoch, P_bar, T_kelvin)]; compensates P to T_ref.

    wheel: optional wheel label (FL/FR/RL/RR) included in the evidence dict
    so the consumer can attribute the result to a specific wheel. Omitted
    (or None) for the legacy single-channel call — no "wheel" evidence key.
    """
    comp = []
    for t, p, tk in samples:
        if tk > 0:
            comp.append((t, p * TIRE_REF_K / tk))
    if len(comp) < 14:
        return DetectorResult(100, "healthy", {}, "Insufficient tire data.")
    n = len(comp)
    xs = [t / 86400.0 / 30.0 for t, _ in comp]   # months
    ys = [p for _, p in comp]
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs)
    slope_bar_m = (num / den) if den else 0.0
    last_p = comp[-1][1]
    score = 100
    reasons = []
    # Continuous health: map the compensated pressure onto 0-100
    # (2.3 bar healthy = 100, 0.9 bar flat = 0). A tire collapsing 1.7 → 0.9 bar
    # reads 60 → 0 instead of freezing at 20 — the flat-death arc stays
    # visible, mirroring the battery's voltage-continuous health.
    score = min(score, round(max(0, min(100, (last_p - 0.9) / (2.3 - 0.9) * 100))))
    if last_p < TIRE_FLOOR_BAR:
        reasons.append(f"P_comp {last_p:.2f} bar < {TIRE_FLOOR_BAR} bar (action)")
    if slope_bar_m < TIRE_SLOPE_BAR_M:
        score = min(score, 55)
        reasons.append(f"slope {slope_bar_m:.3f} bar/month < {TIRE_SLOPE_BAR_M} bar/month")
    score = max(0, score)
    # Severity from thresholds, not the continuous meter: below the 1.8 bar
    # floor is action regardless of score; a truly flat tire (< 1.2 bar)
    # escalates to critical.
    if last_p < 1.2:
        severity = "critical"
    elif last_p < TIRE_FLOOR_BAR:
        severity = "action"
    elif slope_bar_m < TIRE_SLOPE_BAR_M:
        severity = "advisory"
    else:
        severity = _band(score)
    evidence = {"p_comp_bar": f"{last_p:.3f}", "slope_bar_month": f"{slope_bar_m:.4f}",
                "threshold_slope": f"{TIRE_SLOPE_BAR_M}", "floor_bar": f"{TIRE_FLOOR_BAR}"}
    if wheel:
        evidence["wheel"] = wheel
    return DetectorResult(score, severity, evidence,
                          "; ".join(reasons) or "No tire anomaly detected.")

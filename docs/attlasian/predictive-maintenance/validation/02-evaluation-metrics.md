# Evaluation Metrics

The offline evaluator compares detector alerts with simulator ground-truth
labels over a replay window.

| Metric | Meaning |
|---|---|
| Precision | Fraction of detector alerts that match a ground-truth anomaly. |
| Recall | Fraction of ground-truth anomalies detected by the detector. |
| Mean lead time | Average time between the first detector alert and the ground-truth failure point. |

The evaluator also reconstructs the processor's telemetry collection and
temperature compensation so offline results use the same detector inputs as
the live service.

## Interpreting results

High scores on simulator data primarily demonstrate that:

- simulator and detector formulas remain aligned;
- telemetry qualifiers and timestamps are wired correctly; and
- threshold behavior is reproducible.

They do not establish fleet-level precision, recall, or remaining-useful-life
accuracy. That requires independent labeled vehicle data and service outcomes.

## Metric interpretation

For a chosen component and alert threshold:

```text
precision = true_positives / (true_positives + false_positives)
recall    = true_positives / (true_positives + false_negatives)
```

Lead time is measured from the first detector alert to the evaluator's
ground-truth failure point. It should be reported with the soak configuration,
degradation preset, poll interval, lookback window, and threshold set; changing
any of these changes the result.

Per-wheel and per-pad results must be scored at their component identity. A
front-left tire alert should not be counted as a correct rear-right detection
just because both belong to the same vehicle.

## What to record with every evaluation

- VIN and component identity.
- Simulator preset and degradation horizon.
- Telemetry start/end timestamps.
- Data API lookback and poll interval.
- Detector version and threshold values.
- Number of alerts, labels, and missing-signal intervals.

## Sources

- [`evaluate_detectors.py`](../../../../sample-services/predictive-maintenance/scripts/evaluate_detectors.py)
- [`pm-validation.json` generation and dashboard use](../../../../sample-clients/data-web-client/docs/pm-console.md)
- [`2026-08-15-pm-use-case-end-to-end.md`](../../../../docs/superpowers/research/2026-08-15-pm-use-case-end-to-end.md)

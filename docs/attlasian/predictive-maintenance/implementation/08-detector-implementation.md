# Detector Implementation

The detector module contains pure functions. They do not open NATS, query
Bigtable, or know about HTTP. The processor supplies normalized samples and
receives a `DetectorResult`.

## Boundary and contract

```text
processor-owned: bytes, timestamps, pairing, units, temperature compensation
detector-owned: formulas, thresholds, score, severity, evidence, explanation
```

Each detector returns:

```text
DetectorResult {
  health_score: int
  severity: string
  evidence: map<string, string>
  explanation: string
}
```

## Dispatch map

| Function | Input shape | Primary output |
|---|---|---|
| `detect_battery` | Resting `(timestamp, compensated_voltage)` and optional `(timestamp, V_min, I_crank)` | Vehicle-level battery result. |
| `detect_tires` | `(timestamp, pressure_bar, temperature_kelvin)` samples | Per-wheel result with compensated pressure and slope evidence. |
| `detect_brake` | Wear fraction plus optional pad label | Per-pad result with wear evidence. |

## Battery implementation

1. Return healthy/100 when fewer than five resting samples and no cranking data.
2. Seed EWMA with the first compensated voltage and apply `α = 0.1`.
3. Fit ordinary least-squares slope using timestamp days.
4. Map EWMA from 10.5–12.63 V to score 0–100.
5. Cap score for sustained slope or cranking violations.
6. Apply voltage/cranking severity thresholds.

The battery function is deliberately given compensated voltage rather than raw
voltage. It therefore answers one focused question: “does this already
normalized voltage history show low level, negative trend, or cranking risk?”
It does not decide whether the temperature pairing was correct; that is the
processor's responsibility.

## Tire implementation

1. Drop samples with non-positive Kelvin temperature.
2. Compute `P_comp = P × 293.15 / T`.
3. Return healthy/100 with insufficient-data evidence below 14 samples.
4. Fit slope using timestamp months.
5. Map the latest compensated pressure from 0.9–2.3 bar to score 0–100.
6. Apply pressure-floor and slope severity rules.

The tire function treats each wheel as an independent component. It does not
know which NATS subject the sample came from; the caller supplies the wheel
label only so the evidence and output can be attributed correctly.

## Brake implementation

1. Clamp wear fraction to the 0–1 domain at the processor boundary.
2. Compute `100 × (1 - wear)`.
3. Classify `>0.90` as action, `>0.80` as advisory, otherwise healthy.
4. Add the pad label to evidence when the per-pad path is active.

The brake function does not calculate driving energy. It receives a wear
fraction already obtained either from direct per-pad telemetry or from the
processor's legacy energy fallback. This keeps the same threshold behavior for
both data-acquisition paths.

The exact constants and formulas are documented in the [algorithm pages](../algorithms/README.md).

## Testability

The pure-function boundary allows detector unit tests to supply synthetic
series and verify outcomes without infrastructure. Processor tests separately
verify collection, qualifier selection, fallback behavior, cadence, and NATS
subjects. This separation is intentional: a passing detector test does not
prove that the live pipeline supplied the intended signal.

## Sources

- [`detectors.py`](../../../../sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py)
- [`test_detectors.py`](../../../../sample-services/predictive-maintenance/tests/test_detectors.py)
- [`test_processor.py`](../../../../sample-services/predictive-maintenance/tests/test_processor.py)
- [`test_processor_cadence.py`](../../../../sample-services/predictive-maintenance/tests/test_processor_cadence.py)
- [Algorithms section](../algorithms/README.md)

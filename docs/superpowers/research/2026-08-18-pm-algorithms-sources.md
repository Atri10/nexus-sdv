# Predictive Maintenance — Sources & External References

Date: 2026-08-18 (recovered after the git history rebuild)
Status: **Reference — canonical external-source list for the PM algorithm research**
Purpose: The PM research docs (`2026-08-14-pm-algorithms-{battery,brake,tires}-first-principles.md`, `-implementation.md`, `2026-08-15-pm-use-case-end-to-end.md`) anchor every formula to `File(fn)` code citations, but the **external sources** the algorithms were originally derived from (patents, papers, industry statistics) were lost when the git history was reconstructed. This file restores them as the single canonical home. Individual research docs link here rather than duplicating the list.

> **Provenance note:** these references originate from the original
> `2026-08-03-predictive-maintenance-feasibility.md` (research/business context)
> and `2026-08-05-predictive-maintenance-guide.md` (technical explainer). Both
> were among the docs whose sources were lost during the history rebuild; this
> file reconstructs their §Sources from recovered copy.

---

## 1. Battery — algorithm origin

The 12 V starter-battery detector's **two channels** (resting OCV trend + cranking signature) follow the commercial telematics approach:

| Source | What it contributes | Link |
|---|---|---|
| **US20110082621A1** — "Method and system for predicting battery life based on vehicle battery, usage, and environmental data" (Geotab Inc.; Geotab is now part of **Verizon Connect**) | The core idea: receive the battery's **open-circuit and cranking voltages, temperature, and usage**; compare against thresholds/trends to predict remaining life. This is the origin of the slow (resting-OCV trend) + fast (cranking V_min / R_int) dual detector. | https://patents.google.com/patent/US20110082621A1/en |
| **US11742681** — "Methods for analysis of vehicle battery health" (Geotab Inc.) | Newer continuation quantifying degradation from voltage/temperature telemetry; the cranking internal-resistance baseline (1.5× threshold) framing. | https://patents.justia.com/patent/11742681 |

The composite health-score idea in the original spec (60 % resting trend / 25 % cranking / 15 % SOC drift) also traces to this family. (Note: the current code implements a continuous voltage-derived meter + threshold severity instead — see the battery first-principles doc §7.4 for the deliberate divergence.)

## 2. LLM role — why deterministic detection first

The "deterministic detection first, LLM validates/narrates only" decision was grounded in research on LLMs as anomaly detectors:

| Source | What it contributes | Link |
|---|---|---|
| **AXIS** — "AXIS: An EXplainable Anomaly Detection Framework for Time Series" (arXiv:2509.24378) | Evidence that LLMs are strong *narrators* but weak *primary* time-series anomaly detectors — they validate/veto and explain better than they detect. Justifies the architecture where a deterministic detector fires and the LLM only confirms/vetoes + narrates. | https://arxiv.org/abs/2509.24378 |

## 3. Tires — indirect TPMS standard

The tire detector's per-wheel localization and its documented future path (per-wheel speed comparison) reference the UNECE regulation:

| Source | What it contributes | Link |
|---|---|---|
| **UNECE R64** (indirect TPMS) | The standard ABS-based upgrade path: an underinflated wheel rotates faster, so per-wheel speed comparison detects leaks (including symmetrical ones). Cited as future work in the tires doc (per-wheel speeds, not yet in the schema). | https://unece.org/transport/vehicle-regulations (Regulation No. 64) |

## 4. Business/statistics context (the original feasibility deck)

Industry statistics behind the "why predictive maintenance" business case (from the original feasibility doc):

| Stat | Figure | Source |
|---|---|---|
| Battery share of roadside calls | ~26 % (≈1 in 4) | AAA 2024 roadside statistics — https://newsroom.acg.aaa.com/aaa-urges-drivers-to-stay-proactive-on-auto-repair-and-maintenance/ |
| Fleet downtime cost | 50 vehicles × 2 breakdowns × $2,800–4,200 ≈ **$280–420K/yr** | OxMaint fleet-downtime benchmark — https://oxmaint.com/industries/fleet-management/fleet-downtime-analysis-identifying-eliminating-top-causes ; https://www.model1.com/resources/blog/vehicle-downtime-cost/ |
| Preventive-maintenance savings | 18–25 % of downtime cost | McKinsey (fleet PM benchmark) |
| Breakdowns avoidable | 70–75 % | ReliaMag / PwC (fleet maintenance studies) |

## 5. Calibration constants — literature-typical values

The detector constants that are **not** fleet-calibrated but literature-typical (each needs per-fleet calibration; the simulator is the calibration instrument):

| Constant | Value | Where | Source kind |
|---|---|---|---|
| β (battery voltage temperature coefficient) | −0.011 V/°C | `detectors.py(top)` `BATTERY_BETA` | literature-typical for 12 V lead-acid |
| OCV → SoC curve | 12.65 V = 100 % … 11.89 V = 0 % | battery first-principles §3.2 | typical 12 V lead-acid OCV curve |
| Brake pad energy budget | 6 GJ (1500 kg passenger car) | `processor.py(top)` `BRAKE_ENERGY_BUDGET_J` | derived: m·a·d over 40,000 km at 10 % braking |
| Tire permeation baseline | ~0.05 bar/month | tires first-principles §1 | typical radial-tire permeation |
| Tire temp compensation ref | 293.15 K (20 °C) | `detectors.py(top)` `TIRE_REF_K` | ideal-gas law |
| Battery temp compensation ref | 30 °C (India-calibrated) | `detectors.py(top)` `BATTERY_V_REF` | India ambient calibration |

---

## Cross-links

- **Battery first principles** — `2026-08-14-pm-algorithms-battery-first-principles.md`
- **Brake first principles** — `2026-08-14-pm-algorithms-brake-first-principles.md`
- **Tires first principles** — `2026-08-14-pm-algorithms-tires-first-principles.md`
- **Implementation** — `2026-08-14-pm-algorithms-implementation.md`
- **End-to-end use case** — `2026-08-15-pm-use-case-end-to-end.md`

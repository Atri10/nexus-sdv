# superpowers — design, plan, and research docs

This directory holds the design / plan / research trail for the
predictive-maintenance, demo-experience, and UI-redesign work on the
local no-GCP stack. Layout:

```
docs/superpowers/
├── README.md                     # this index
├── 2026-08-10-predictive-maintenance-guide.md   # operator's usage & ops guide (start here)
├── specs/                        # design specs (what + why)
│   ├── 2026-07-18-nats-bigtable-ingestion-verification-design.md
│   ├── 2026-07-19-ui-chart-redesign-design.md
│   ├── 2026-08-05-command-deck-design.md
│   ├── 2026-08-05-demo-experience-design.md
│   ├── 2026-08-05-local-dev-fixes-design.md
│   └── 2026-08-09-predictive-maintenance-prototype-design.md
├── plans/                        # implementation plans (how)
│   ├── 2026-07-18-nats-bigtable-ingestion-verification-plan.md
│   ├── 2026-07-19-ui-chart-redesign.md
│   ├── 2026-08-05-command-deck.md
│   ├── 2026-08-05-demo-experience.md
│   ├── 2026-08-05-local-dev-fixes.md
│   ├── 2026-08-06-telemetry-dashboard.md
│   └── 2026-08-09-predictive-maintenance-prototype.md
└── research/                     # first-principles + as-implemented math
    ├── 2026-08-14-pm-algorithms-implementation.md           # code → math → why (canonical)
    ├── 2026-08-14-pm-algorithms-battery-first-principles.md
    ├── 2026-08-14-pm-algorithms-brake-first-principles.md
    └── 2026-08-14-pm-algorithms-tires-first-principles.md
```

## Reading order

1. **Predictive maintenance** — start with the operator guide
   (`2026-08-10-predictive-maintenance-guide.md`), then the design spec
   (`specs/2026-08-09-…-design.md`), then the implementation reference
   (`research/2026-08-14-pm-algorithms-implementation.md`, includes the
   end-to-end mermaid data-flow and fast-demo mechanics), and finally the
   per-component first-principles docs.
2. **Demo / dashboard** — `specs/2026-08-05-demo-experience-design.md` +
   `plans/2026-08-05-demo-experience.md`, then `specs/2026-08-05-command-deck-design.md`,
   then `specs/2026-07-19-ui-chart-redesign-design.md`.
3. **Local stack** — `specs/2026-08-05-local-dev-fixes-design.md` +
   `plans/2026-08-05-local-dev-fixes.md`, and the ingestion verification pair
   (`specs/2026-07-18-…-design.md` + `plans/2026-07-18-…-plan.md`).

## Conventions

- **Diagrams are Mermaid** (```mermaid blocks) so they render on GitHub —
  no ASCII art. Data flows use `flowchart LR`, request/response steps use
  `sequenceDiagram`.
- **Research docs are dated + canonical**: the `2026-08-14-pm-algorithms-*`
  set is the current PM algorithm reference; older feasibility/algorithm
  notes were folded into it. Link to these files, not to spec text that
  predates the implementation.
- **Plans are historical**: they describe the intended change at the time.
  Where the shipped code diverges from a plan, the research/implementation
  docs are authoritative.

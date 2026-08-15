# Runtime VIN Switching + Per-Wheel/Pad PM Modeling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the demo simulator adopt any pool VIN at runtime (Start on a fresh VIN actually runs that VIN, clearing the old VIN's data), and model tires/brakes per-wheel/pad so asymmetric degradation is detected and displayed.

**Architecture:** Single sim subscribes `commands.>.demo` and adopts the requested VIN on start (swap active VIN under lock, reseed degradation, clear drive state). NATS perms broadened in DEMO_MODE so the sim may publish any VIN. Tires/brakes become per-wheel sensors (`TIRE_PRESSURE.FL`…`BRAKE_WEAR.RR`) flowing sim → connector → Bigtable → detector (×4 per component) → `pm.{VIN}.tires.{wheel}` → web (worst-wheel summary + per-wheel detail + clear-on-switch).

**Tech Stack:** Go (sim, connector, auth-callout), Python (detector), TypeScript/Next.js (web), NATS, Bigtable emulator.

## Global Constraints

- **Sensor names (exact):** `TIRE_PRESSURE.{FL,FR,RL,RR}`, `TIRE_TEMP.{FL,FR,RL,RR}`, `BRAKE_WEAR.{FL,FR,RL,RR}` → connector stores as `dynamic:<name>` columns.
- **PM subjects (exact):** `pm.{VIN}.tires.{wheel}`, `pm.{VIN}.brake.{pad}`, `pm.{VIN}.battery` (unchanged). Web parses the 4th subject token as wheel/pad.
- **Ground truth (exact):** sim reply gains `tires.{wheel}.pressure_bar` / `.temp_c` and `brakes.{wheel}.wear_fraction`.
- **Auth:** `DEMO_MODE=true` on auth-callout grants broad NATS perms (`telemetry.>`, `telemetry-generic.>`, `commands.>`, `_INBOX.>`); unset keeps per-VIN isolation.
- **Continuous health meters (existing):** scores are continuous in the signal (voltage 12.63→10.5 V = 100→0, pressure 2.3→0.9 bar = 100→0); severity from thresholds (battery action <12.2V critical <11.8V; tires action <1.8bar critical <1.2bar).
- All commits signed (`git -c core.hooksPath=/dev/null commit -S`), Conventional Commits.
- No personal-tool mentions in code/docs. No secrets.

---

### Task A: Simulator — VIN adoption + per-wheel tires/brakes

**Files:**
- Modify: `sample-clients/vehicle-client/main.go` (control subscription, `controlState.adopt`, publish loop per-wheel, ground truth)
- Modify: `sample-clients/vehicle-client/degradation.go` (4 tire curves, 4 brake accumulators)
- Test: `sample-clients/vehicle-client/*_test.go` (new per-wheel + adoption tests)
- Modify: `sample-clients/vehicle-client/trip_logic.go` (brake energy per-pad if accumulator lives there)

**Interfaces:**
- Consumes: existing `DegradationConfig.TirePressureAt(day)`, `TireTempAt(day)`, `brakeEnergyBudgetJ`, `poolIndex(vin)`, `defaultDegradationConfig(component, poolIndex)`.
- Produces:
  - `controlState.adopt(vin string) error` — swaps active VIN, reseeds degradation, clears drive/battery state. Called from the `start` handler when `req.Vin` is non-empty and != current VIN.
  - Sensor names emitted per wheel: `TIRE_PRESSURE.FL` … `TIRE_PRESSURE.RR`, `TIRE_TEMP.FL` … `TIRE_TEMP.RR`, `BRAKE_WEAR.FL` … `BRAKE_WEAR.RR` (fraction 0..1).
  - Ground truth gains `tires.{wheel}.pressure_bar`, `tires.{wheel}.temp_c`, `brakes.{wheel}.wear_fraction`.
  - Control subscription: `commands.>.demo` (wildcard) instead of `commands.<bootVIN>.demo`.

- [ ] **Step 1: Write failing test for VIN adoption**

```go
func TestControlStateAdopt(t *testing.T) {
    ctl := newControlState("VIN1009", "metrics")
    if err := ctl.adopt("VIN1002"); err != nil { t.Fatal(err) }
    if ctl.vin != "VIN1002" { t.Fatalf("vin = %s, want VIN1002", ctl.vin) }
    // Degradation re-seeded from pool index of the new VIN
    for _, deg := range ctl.degradation {
        want := defaultDegradationConfig(deg.Component, poolIndex("VIN1002")).HorizonDays
        if deg.HorizonDays != want { t.Fatalf("HorizonDays = %f, want %f", deg.HorizonDays, want) }
    }
}
```

- [ ] **Step 2: Run test to verify it fails** — `cd sample-clients/vehicle-client && go test ./...` → FAIL (adopt undefined)

- [ ] **Step 3: Implement `adopt`** — under `c.mu`: set `c.vin = vin`, call the same reset logic as `resetSimulation` (reseed `HorizonDays` via `poolIndex(vin)`, clear `groundTruth`/`live`/`routeDist`, reset drive state via `c.resetFn`).

- [ ] **Step 4: Wildcard control subscription** — change the `commands.<vin>.demo` subscribe to `commands.>.demo` (find the subscribe site; likely `ensureControlSub`). Keep replying to the message's reply subject (unchanged).

- [ ] **Step 5: Start handler adopts** — in the `start` case, if `req.Vin != "" && req.Vin != c.vin`, call `adopt(req.Vin)` before starting. Verify `resetSimulation` is called after adopt (so the fresh VIN starts clean).

- [ ] **Step 6: Per-wheel tire curves** — in `degradation.go`, replace the single `TirePressureAt` with per-wheel: add a `wheel` param or a map keyed FL/FR/RL/RR with staggered failure (e.g. FL leaks first — replicate the 3-phase curve with a per-wheel phase offset; FL reaches flat earliest, others follow). Keep `TireTempAt` per-wheel (mirror the pressure curve). Update `TirePressureAt(day)` signature → `TirePressureAt(wheel, day)` and fix call sites.

- [ ] **Step 7: Per-pad brake wear** — add `BrakeWearAt(wheel, energyUsedJ)` returning per-pad fraction (0..1): split the existing `brakeEnergyBudgetJ` per pad (e.g. equal share, with a bias so one pad wears faster — e.g. front pads wear 1.4× rear, or FL first). Wire the publish loop to accumulate per-pad energy.

- [ ] **Step 8: Publish per-wheel sensors** — in `buildChassisReport` (and the telemetry-path publish), emit `TIRE_PRESSURE.FL`…`RR`, `TIRE_TEMP.FL`…`RR`, `BRAKE_WEAR.FL`…`RR` with per-wheel values from Steps 6-7.

- [ ] **Step 9: Ground truth per-wheel** — the status reply's `ground_truth` gains `tires.{wheel}.pressure_bar`, `tires.{wheel}.temp_c`, `brakes.{wheel}.wear_fraction`.

- [ ] **Step 10: Run all tests** — `cd sample-clients/vehicle-client && go test ./...` → all pass.

- [ ] **Step 11: Commit** — `git add sample-clients/vehicle-client/ && git commit -S -m "feat(sim): adopt any pool VIN on start; per-wheel tires + brake pads"`

---

### Task B: Auth-callout — DEMO_MODE broad perms

**Files:**
- Modify: `base-services/auth-callout/main.go`
- Modify: `local-dev/docker-compose.yml` (auth-callout env `DEMO_MODE=true`)
- Test: `base-services/auth-callout/*_test.go` (add demo-mode perm test)

**Interfaces:**
- Consumes: existing `perms` build (per-VIN grants in `case "telemetry-client"`, `case "edge-device"`).
- Produces: `DEMO_MODE` env read at startup; when truthy, the returned `userClaims.Permissions` includes `telemetry.>`, `telemetry-generic.>`, `commands.>`, `_INBOX.>` on both Pub and Sub Allow.

- [ ] **Step 1: Write failing test for demo-mode perms**

```go
func TestDemoModeGrantsBroadPerms(t *testing.T) {
    os.Setenv("DEMO_MODE", "true")
    defer os.Unsetenv("DEMO_MODE")
    perms := buildPermissions(testAuthRequest(t, "telemetry-client", "VIN1009"))
    want := []string{"telemetry.>", "telemetry-generic.>", "commands.>", "_INBOX.>"}
    for _, w := range want {
        if !perms.Pub.Allow.Contains(w) { t.Errorf("Pub allow missing %s", w) }
        if !perms.Sub.Allow.Contains(w) { t.Errorf("Sub allow missing %s", w) }
    }
}
```

- [ ] **Step 2: Run to verify fails** — `cd base-services/auth-callout && go test ./...` → FAIL (no buildPermissions or no DEMO_MODE)

- [ ] **Step 3: Implement** — read `DEMO_MODE` from env at the top of the permission-builder (or a `isDemo()` helper). When true, skip the per-VIN grants and add the 4 broad subjects to both Pub.Allow and Sub.Allow. Keep the per-VIN path for non-demo.

- [ ] **Step 4: Wire compose** — add `DEMO_MODE=true` to auth-callout's environment in `local-dev/docker-compose.yml`.

- [ ] **Step 5: Run tests** — `cd base-services/auth-callout && go test ./...` → pass.

- [ ] **Step 6: Commit** — `git add base-services/auth-callout/ local-dev/docker-compose.yml && git commit -S -m "feat(auth): DEMO_MODE grants fleet-wide NATS perms for VIN switching"`

---

### Task C: Detector — per-wheel/pad processing

**Files:**
- Modify: `sample-services/predictive-maintenance/src/predictive_maintenance/core/processor.py`
- Modify: `sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py`
- Modify: `sample-services/predictive-maintenance/tests/test_detectors.py`, `tests/test_evaluate.py`, `tests/test_processor.py`
- Modify: `sample-services/predictive-maintenance/README.md` (subject/component docs)

**Interfaces:**
- Consumes: sensor names `dynamic:TIRE_PRESSURE.FL` etc., `dynamic:BRAKE_WEAR.FL` etc. from data-api; existing `detect_tires(samples, recommended_bar=2.3)` and `detect_brake(wear_fraction)`.
- Produces:
  - `processor` fetches per-wheel columns and runs `detect_tires` ×4, `detect_brake` ×4.
  - Published subjects: `pm.{VIN}.tires.{wheel}`, `pm.{VIN}.brake.{pad}` (4 each), battery unchanged.
  - Evidence dicts gain `"wheel": "FL"` / `"pad": "FL"`.
  - `detect_tires(samples, recommended_bar=2.3, wheel="FL")` — wheel label param.

- [ ] **Step 1: Write failing test for per-wheel tire run**

```python
def test_tires_per_wheel():
    # 30 samples FL pressure 2.3 → 1.0 bar (flat), FR steady 2.3
    import math
    fl = [(i*86400.0, 2.3 - 1.3*i/30, 303.15) for i in range(30)]
    fr = [(i*86400.0, 2.3, 303.15) for i in range(30)]
    rfl = detect_tires(fl, recommended_bar=2.3, wheel="FL")
    rfr = detect_tires(fr, recommended_bar=2.3, wheel="FR")
    assert rfl.severity == "critical" and rfl.health_score < 15
    assert rfr.severity == "healthy"
    assert rfl.evidence.get("wheel") == "FL"
```

- [ ] **Step 2: Run to verify fails** — `cd sample-services/predictive-maintenance && uv run pytest tests/test_detectors.py::test_tires_per_wheel` → FAIL (no wheel param)

- [ ] **Step 3: Implement per-wheel in detectors** — add `wheel`/`pad` param to `detect_tires`/`detect_brake`; include in evidence. Keep single-channel behavior when param omitted (backward compat for existing tests).

- [ ] **Step 4: Processor fetches per-wheel** — extend the sensor list to `dynamic:TIRE_PRESSURE.FL`…`RR`, `dynamic:TIRE_TEMP.FL`…`RR`, `dynamic:BRAKE_WEAR.FL`…`RR` (drop or keep `dynamic:BRAKE_PEDAL_PCT` per current brake-energy calc — keep both: BRAKE_PEDAL_PCT still drives the energy accumulator; BRAKE_WEAR.* is the per-pad fraction). Run 4× tires + 4× brake. Publish `pm.{VIN}.tires.{wheel}` / `pm.{VIN}.brake.{pad}`.

- [ ] **Step 5: Update existing tests** — any test asserting single-channel `pm.{VIN}.tires` / `pm.{VIN}.brake` subjects → expect the per-wheel subjects (or update the fixture). Run full suite.

- [ ] **Step 6: Run all PM tests** — `cd sample-services/predictive-maintenance && uv run pytest tests/` → all pass.

- [ ] **Step 7: Commit** — `git add sample-services/predictive-maintenance/ && git commit -S -m "feat(pm): per-wheel tire + per-pad brake detection, pm.*.{wheel} subjects"`

---

### Task D: Web — per-wheel display + clear-on-switch

**Files:**
- Modify: `sample-clients/data-web-client/src/lib/pm-types.ts` (wheel/pad field, component union)
- Modify: `sample-clients/data-web-client/src/lib/pm-health.ts` (parse per-wheel, worst-wheel aggregate, clear-on-switch)
- Modify: `sample-clients/data-web-client/src/components/pm/pm-charts.tsx` (per-wheel rows in dialog, worst-wheel summary)
- Modify: `sample-clients/data-web-client/src/app/api/pm/stream/route.ts` (subject parse 4th token) if needed
- Modify: `sample-clients/data-web-client/src/app/pm/page.tsx` (clear state on sim VIN change)
- Test: `sample-clients/data-web-client/src/lib/pm-types.test.ts`, new `pm-health.test.ts`

**Interfaces:**
- Consumes: `PmMessage{ vin, component, wheel?, health_score, severity, evidence }`; `CoherentHealth{ score, severity, provisional, reason, wheel? }`; sim ground truth `tires.{wheel}.pressure_bar`.
- Produces:
  - `coherentHealth(component, { batteryVoltage, brakeWearFrac, tirePressures: {FL,FR,RL,RR}, pm })` — `tirePressures` per-wheel, worst-wheel drives the main badge.
  - `clearPmState(vin)` / clear-on-switch: when the discovered sim VIN changes, wipe PM maps + chart buffers + demo buffers.
  - `pm-charts.tsx` dialog: per-wheel/pad rows with score + reason; main card: worst-wheel summary.

- [ ] **Step 1: Write failing test for per-wheel parse + worst-wheel**

```typescript
import { pmMessageFromSubject, worstWheel } from './pm-health';
test('parses 4-token pm subject into wheel', () => {
  const m = pmMessageFromSubject('pm.VIN1009.tires.fl');
  expect(m?.component).toBe('tires');
  expect(m?.wheel).toBe('fl');
});
test('worst wheel drives aggregate severity', () => {
  const agg = worstWheel([
    { wheel: 'fl', score: 5, severity: 'critical' },
    { wheel: 'fr', score: 90, severity: 'healthy' },
  ]);
  expect(agg.severity).toBe('critical');
  expect(agg.score).toBe(5);
});
```

- [ ] **Step 2: Run to verify fails** — `cd sample-clients/data-web-client && bun test --isolate src/lib/pm-health.test.ts` → FAIL

- [ ] **Step 3: Implement parse + worst-wheel** — `pmMessageFromSubject` splits `pm.{vin}.{component}.{wheel}` (3-token → wheel undefined, back-compat); `worstWheel` = min score across wheels; `coherentHealth` uses per-wheel pressures + worst-wheel aggregate for the summary.

- [ ] **Step 4: Clear-on-switch** — track current sim VIN (from discovery/status); when it changes, call a `clearAllPm()` + `clearTelemetry()` that empties PM maps, health maps, chart buffers. Wire in `page.tsx` where discovery result is consumed.

- [ ] **Step 5: pm-charts dialog per-wheel** — the expand dialog lists each wheel/pad row (score, severity, reason); the card summary shows the worst-wheel label + score.

- [ ] **Step 6: Run web tests + lint + build** — `cd sample-clients/data-web-client && bun test --isolate && bun run lint && bun run build` → all green.

- [ ] **Step 7: Commit** — `git add sample-clients/data-web-client/ && git commit -S -m "feat(web): per-wheel PM display, worst-wheel summary, clear state on VIN switch"`

---

### Task E: Integration verification (after A-D merge to dev)

- [ ] **Step 1: Rebuild + restart affected services** — `cd local-dev && docker compose --env-file .env.base-services --env-file .env.sample-services build vehicle-simulator auth-callout predictive-maintenance data-web-client && docker compose ... up -d`
- [ ] **Step 2: Verify VIN switch** — browser on `/pm`: select VIN1002 + Start → sim adopts VIN1002 (status reply `vin: VIN1002`), telemetry flows as `telemetry.VIN1002`, PM messages as `pm.VIN1002.*`, old VIN's charts cleared.
- [ ] **Step 3: Verify per-wheel PM** — `/pm` shows 4 tire rows + 4 brake rows; worst-wheel (e.g. FL) drives the summary badge to critical while others stay healthy.
- [ ] **Step 4: Verify auth** — sim publishes `telemetry.VIN1002` with DEMO_MODE on; no auth violation in logs.
- [ ] **Step 5: Commit any integration fixes.**

## Self-Review

- **Spec coverage:** Part 1 (VIN adopt = Task A; auth broad perms = Task B; clear-on-switch = Task D step 4) ✓. Part 2 (per-wheel sim = A steps 6-9; connector generic = verified no hardcode; detector ×4 = C; web worst-wheel + dialog = D) ✓. Ground-truth per-wheel = A step 9 ✓. Continuous meters = existing, global constraint ✓.
- **Placeholders:** none — every step has concrete code or commands.
- **Type consistency:** `adopt(vin string)`, `detect_tires(..., wheel="FL")`, `pmMessageFromSubject`, `worstWheel`, `tirePressures: {FL,FR,RL,RR}` — consistent across tasks via Interfaces blocks.
- **Parallel safety:** A, B, C, D touch disjoint files (sim Go / auth-callout Go / detector py / web ts). Contracts fixed. D depends on A's sensor names + C's subjects — but both are contract-fixed, so D can proceed against the contract (integration verifies actual). All four parallel; E after merge.

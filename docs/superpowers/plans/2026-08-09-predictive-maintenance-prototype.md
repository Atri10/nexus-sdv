# Predictive Maintenance Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a showcaseable local prototype of the Predictive Maintenance Copilot: physics-informed degradation data → deterministic detector math (battery M1/M2, brake-energy, temp-compensated tires) → `pm.{VIN}.{component}` alerts on NATS → /demo gauges + /pm fleet-health dashboard.

**Architecture:** A new Python detector service (`sample-services/predictive-maintenance/`) mirrors `trip_analyzer`'s pattern (FastAPI, poll data-api → compute → publish NATS). The Go `vehicle-simulator` gains physics-informed degradation trajectories + trip data and emits `TIRE_TEMP`. The web client gets an SSE `/api/pm/stream` (mirroring `/api/scoring/stream`) plus /demo health widgets and a new `/pm` page. Alert messages ride NATS → SSE; no new storage.

**Tech Stack:** Python 3.13 + uv + betterproto (service), Go 1.25 (simulator), protobuf (pm-message proto), Next.js + React + Tailwind + framer-motion (web), NATS 2.10, docker-compose (local).

## Global Constraints

- **Local-only**: no GCP/cloud changes; `local-dev/docker-compose.yml` + `local-dev/Makefile` are the only IaC touched. Do not touch `iac/`.
- **No LLM**: explanations are deterministic templates; no API keys, no LLM deps.
- **No new storage**: alerts ride NATS → SSE; web client keeps bounded in-memory/session list (mirror `useScoringMessages`). No Bigtable writes for alerts.
- **`scoring.*` untouched**: new subjects are `pm.{VIN}.{component}` only.
- **PyBaMM is offline-only**: the Go sim runtime has zero Python dependency; a calibration script may require `pybamm` in its own venv, but shipped curve defaults are checked into config.
- **Repo conventions**: Python service mirrors `trip_analyzer` structure (config via pydantic-settings, zap-style logging, betterproto stubs); Go follows `vehicle-client` patterns; web uses existing components (`@/components/ui/*`, framer-motion, sonner toasts).
- **India calibration**: battery temperature reference 30 °C, β ≈ −0.011 V/°C, degradation horizon 60–180 days.
- **Version floors** (from AGENTS.md): Python ≥3.13 + uv, Go 1.24/1.25, Node 22 + bun (never npm) for the web client, protoc on PATH for stub regen.
- **No formatter/linter CI gates**: keep gofmt / ruff / prettier defaults; web client runs `bun run lint` + `bun run build`.
- **Generated artifacts never committed**: `*.pb.go`, `*_pb2.py`, `*.pb.py` stubs are gitignored where applicable; commit the `.proto` and the checked-in generated copies the build consumes (match existing per-service convention).

---

## File Structure Map

```
proto/vehicle_telemetry.proto                    # MODIFY: + optional float TIRE_TEMP = 16
sample-clients/vehicle-client/
  main.go                                        # MODIFY: battery degradation, brake accumulator, tire leak+temp, per-VIN config, degradation control action, ground-truth reply
  trip_route.go / trip_logic.go                  # MODIFY (reuse): drive cycles, GPS; brake events feed
  Makefile / Dockerfile.local                    # untouched
sample-services/predictive-maintenance/          # NEW service
  proto/pm-message.proto                         # NEW
  src/predictive_maintenance/
    __init__.py
    main.py                                      # FastAPI lifespan mirror of trip_analyzer
    config/config.py                             # pydantic-settings: NATS, data-api, SCHEDULED_VINS, POLL_INTERVAL, thresholds
    config/logging.py
    model/pm_message.py                          # betterproto-generated PmMessage
    client/nats_client.py                        # mirror trip_analyzer NatsConnector
    client/DataApiConnector.py                   # mirror trip_analyzer
    core/detectors.py                            # pure functions: detect_battery/detect_brake/detect_tires
    core/processor.py                            # poll per VIN → detectors → publish
    core/scheduler.py                            # mirror TripScheduler
    api/router.py + api/endpoints/healthcheck.py
  scripts/calibrate_battery_curve.py             # OPTIONAL offline PyBaMM fit → JSON config
  pyproject.toml / uv.lock / Dockerfile.local
sample-clients/data-web-client/
  src/proto/pm.proto                             # NEW (copy of pm-message.proto)
  src/lib/pm-types.ts                            # NEW: PmMessage TS type, parse, severityColor
  src/hooks/usePmMessages.ts                     # NEW
  src/app/api/pm/stream/route.ts                 # NEW
  src/components/pm/pm-health-matrix.tsx         # NEW
  src/components/pm/pm-alert-feed.tsx            # NEW
  src/components/pm/pm-drill-down.tsx            # NEW
  src/app/pm/page.tsx                            # NEW
  src/components/demo/component-panel.tsx        # MODIFY: health gauge
  src/components/demo/vehicle-schematic.tsx      # MODIFY: alert chips
  src/app/demo/page.tsx                          # MODIFY: alert ticker + pass alert state
  src/components/sidebar.tsx                     # MODIFY: PM nav entry
  public/pm-validation.json                      # NEW: static evaluator numbers
local-dev/
  docker-compose.yml                             # MODIFY: + predictive-maintenance service
  Makefile                                       # MODIFY: + pm-demo target
  scripts/test-local-flow.sh                     # MODIFY: + pm loop assertion
docs/superpowers/plans/2026-08-09-predictive-maintenance-prototype.md  # this plan
```

---

### Task 1: PM message proto + generated stub

**Files:**
- Create: `sample-services/predictive-maintenance/proto/pm-message.proto`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/model/pm_message.py`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/__init__.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PmMessage` betterproto dataclass — fields `vin: str` (1), `component: str` (2), `health_score: int` (3), `severity: str` (4), `evidence: Dict[str,str]` (5), `explanation: str` (6), `timestamp: str` (7). Later tasks serialize this to NATS and decode it in the web client.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_pm_message.py
from predictive_maintenance.model.pm_message import PmMessage

def test_pm_message_roundtrip():
    m = PmMessage(vin="VIN1001", component="battery", health_score=62,
                  severity="advisory", evidence={"ewma_voltage": "12.38"},
                  explanation="Resting voltage 12.38 V.", timestamp="2026-08-09T00:00:00Z")
    raw = m.SerializeToString()
    m2 = PmMessage().parse(raw)
    assert m2.vin == "VIN1001" and m2.health_score == 62 and m2.evidence["ewma_voltage"] == "12.38"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-services/predictive-maintenance && uv run pytest tests/test_pm_message.py -v`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the proto and generate the stub**

`proto/pm-message.proto`:
```proto
syntax = "proto3";
package pm;

message PmMessage {
  string vin = 1;
  string component = 2;   // battery | brake | tires
  int32 health_score = 3; // 0-100
  string severity = 4;    // healthy | advisory | action | critical
  map<string, string> evidence = 5;
  string explanation = 6;
  string timestamp = 7;   // RFC3339
}
```

Scaffold the service package and pyproject (`uv init`), then regen with the repo's betterproto convention (see `sample-services/trip_analyzer/Makefile` for the exact protoc + grpc_tools command; run `make proto` after creating the service Makefile with the same pattern):
```bash
uv run grpc_tools.protoc -I proto --python_betterproto_out=src/predictive_maintenance/model proto/pm-message.proto
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_pm_message.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sample-services/predictive-maintenance
git commit -m "feat(pm): pm-message proto + betterproto stub"
```

---

### Task 2: Detector math (pure functions) + unit tests

**Files:**
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py`
- Create: `sample-services/predictive-maintenance/tests/test_detectors.py`

**Interfaces:**
- Consumes: nothing from Task 1 (pure math; `DetectorResult` is a plain dataclass here).
- Produces:
  - `@dataclass DetectorResult(health_score: int, severity: str, evidence: dict[str,str], explanation: str)`.
  - `def detect_battery(rest_voltages: list[tuple[float,float]], crank: list[tuple[float,float,float]], baseline_r_int: float | None = None) -> DetectorResult` — inputs are `(timestamp_epoch, value)` pairs: rest readings `(t, V_rest)` and cranking triples `(t, V_min, I_crank)`; returns result (severity `healthy|advisory|action|critical`).
  - `def detect_brake(wear_fraction: float, wear_rate_per_km: float | None = None) -> DetectorResult`.
  - `def detect_tires(pressure_samples: list[tuple[float,float,float]], recommended_bar: float = 2.3) -> DetectorResult` — `(t, P_comp, T_kelvin)`; temp-compensates internally, fits 14-day slope.
  - Constants: `BATTERY_EWMA_ALPHA=0.1`, `BATTERY_V_REF=30.0`, `BATTERY_BETA=-0.011`, `BATTERY_ADVISORY_V=12.4`, `BATTERY_ACTION_V=12.2`, `BATTERY_SLOPE_MV=-0.5`, `CRANK_VMIN=9.5`, `CRANK_R_MULT=1.5`, `BRAKE_ADVISORY=0.8`, `BRAKE_ACTION=0.9`, `TIRE_REF_K=293.15`, `TIRE_SLOPE_BAR_M=-0.15`, `TIRE_FLOOR_BAR=1.8`.
- Task 3 consumes these exact signatures.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_detectors.py
from predictive_maintenance.core.detectors import (
    detect_battery, detect_brake, detect_tires, DetectorResult,
    BATTERY_ADVISORY_V, BATTERY_ACTION_V,
)

def test_battery_healthy_no_alert():
    # Resting voltage pinned at 12.6 V over 40 days, no cranking events.
    rest = [(i * 86400.0, 12.6) for i in range(40)]
    r = detect_battery(rest, [])
    assert r.severity == "healthy" and r.health_score >= 70

def test_battery_degrading_slope_advisory():
    # 12.60 → 12.40 V linear over 30 days → slope -0.0067 V/day < -0.5 mV/day.
    rest = [(i * 86400.0, 12.60 - i * 0.20 / 30.0) for i in range(30)]
    r = detect_battery(rest, [])
    assert r.severity == "advisory"
    assert "12.4" in r.explanation  # evidence surfaced in the template

def test_battery_cranking_critical():
    rest = [(0.0, 12.6)] * 1
    crank = [(1.0, 9.0, 180.0)]  # V_min 9.0 < 9.5 → critical
    r = detect_battery(rest, crank)
    assert r.severity == "critical"

def test_battery_insufficient_data_no_alert():
    rest = [(i * 86400.0, 12.6) for i in range(3)]  # < 5 samples
    r = detect_battery(rest, [])
    assert r.severity == "healthy" and r.health_score == 100  # no signal, no alert

def test_brake_wear_advisory_action():
    assert detect_brake(0.85).severity == "advisory"
    assert detect_brake(0.95).severity == "action"
    assert detect_brake(0.5).severity == "healthy"

def test_tires_slow_leak_slope_advisory():
    # 2.30 → 2.26 bar over 14 days ≈ -0.086 bar/month → below slope rule, no alert
    # from slope; 2.3 → 1.75 over 30 days → crosses floor → action.
    import math
    days = 30
    samples = [(i * 86400.0, 2.30 - 0.55 * i / days, 303.15) for i in range(days)]
    r = detect_tires(samples, recommended_bar=2.3)
    assert r.severity == "action"  # floor 1.75 < 1.8

def test_tires_temp_compensation():
    # Same absolute pressure at hot temp must compensate to a higher P_comp.
    r = detect_tires([(0.0, 2.3, 303.15)], recommended_bar=2.3)
    assert r.health_score > 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_detectors.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Implement the detectors**

```python
# src/predictive_maintenance/core/detectors.py
"""Deterministic predictive-maintenance detectors (no ML, no LLM).

Thresholds are the values locked in by docs/superpowers/research/
2026-08-14-pm-algorithms-implementation.md and the design spec.
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
    if len(rest) < 5:
        return DetectorResult(100, "healthy", {}, "Insufficient data — no alert.")
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
    score = 100
    reasons = []
    if ewma < BATTERY_ACTION_V:
        score = min(score, 25)
        reasons.append(f"EWMA {ewma:.2f} V < {BATTERY_ACTION_V} V (action)")
    elif ewma < BATTERY_ADVISORY_V:
        score = min(score, 60)
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
    return DetectorResult(
        health_score=score,
        severity="critical" if score < 30 else _band(score),
        evidence={"ewma_voltage": f"{ewma:.2f}", "slope_mv_day": f"{slope_mv_day:.2f}",
                  "threshold_advisory": f"{BATTERY_ADVISORY_V}", "threshold_action": f"{BATTERY_ACTION_V}"},
        explanation=("Resting voltage {:.2f} V, drifting {:.2f} mV/day (advisory threshold {} V).".format(
            ewma, slope_mv_day, BATTERY_ADVISORY_V)) or ("; ".join(reasons) or "No anomaly."),
    )


def detect_brake(wear_fraction, wear_rate_per_km=None):
    score = max(0, min(100, round(100 * (1 - wear_fraction))))
    if wear_fraction > BRAKE_ACTION:
        severity, msg = "action", f"Wear index {wear_fraction:.0%} > {BRAKE_ACTION:.0%}"
    elif wear_fraction > BRAKE_ADVISORY:
        severity, msg = "advisory", f"Wear index {wear_fraction:.0%} > {BRAKE_ADVISORY:.0%}"
    else:
        severity, msg = "healthy", f"Wear index {wear_fraction:.0%}"
    return DetectorResult(score, severity,
                          {"wear_fraction": f"{wear_fraction:.3f}",
                           "wear_rate_per_km": f"{wear_rate_per_km or 0:.6f}"},
                          f"{msg} of the calibrated pad budget.")


def detect_tires(samples, recommended_bar=2.3):
    """samples: list[(t_epoch, P_bar, T_kelvin)]; compensates P to T_ref."""
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
    if last_p < TIRE_FLOOR_BAR:
        score = min(score, 20)
        reasons.append(f"P_comp {last_p:.2f} bar < {TIRE_FLOOR_BAR} bar (action)")
    if slope_bar_m < TIRE_SLOPE_BAR_M:
        score = min(score, 55)
        reasons.append(f"slope {slope_bar_m:.3f} bar/month < {TIRE_SLOPE_BAR_M} bar/month")
    score = max(0, score)
    return DetectorResult(score, "action" if score < 30 else _band(score),
                          {"p_comp_bar": f"{last_p:.3f}", "slope_bar_month": f"{slope_bar_m:.4f}",
                           "threshold_slope": f"{TIRE_SLOPE_BAR_M}", "floor_bar": f"{TIRE_FLOOR_BAR}"},
                          "; ".join(reasons) or "No tire anomaly detected.")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_detectors.py -v`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add sample-services/predictive-maintenance/src/predictive_maintenance/core/detectors.py tests/test_detectors.py
git commit -m "feat(pm): deterministic battery/brake/tire detectors + tests"
```

---

### Task 3: Detector service skeleton (poll → compute → publish)

**Files:**
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/{config/config.py,config/logging.py,main.py}`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/client/{nats_client.py,DataApiConnector.py}`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/core/{processor.py,scheduler.py}`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/api/{router.py,__init__.py}`
- Create: `sample-services/predictive-maintenance/src/predictive_maintenance/api/endpoints/{healthcheck.py,__init__.py}`

**Interfaces:**
- Consumes: Task 1 `PmMessage`; Task 2 detector functions.
- Produces: FastAPI app `predictive_maintenance.main:app`; `Processor.run(vin)` publishes `pm.{vin}.{component}`; config keys `nats_host/nats_port/nats_user/nats_password`, `data_api_grpc_addr`, `scheduled_vins`, `poll_interval_seconds`; subject `pm.{vin}.battery|brake|tires`.

- [ ] **Step 1: Copy the trip_analyzer skeleton and adapt**

Copy `sample-services/trip_analyzer/{config,client,core/scheduler.py,api,main.py}` into the pm package, renaming module `trip_analyzer` → `predictive_maintenance` and `scoring` → `pm`. Keep `NatsConnector`, `DataApiConnector`, `TripScheduler` (rename `PmScheduler`), the FastAPI lifespan, and the healthcheck endpoint verbatim — they are the established pattern.

- [ ] **Step 2: Write the config**

```python
# config/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", extra="ignore")
    nats_host: str = "nats"
    nats_port: int = 4222
    nats_user: str = "connector"
    nats_password: str = "connector-pass"
    data_api_grpc_addr: str = "data-api:8080"
    scheduled_vins: str = ""          # comma-separated; empty = none
    poll_interval_seconds: int = 60
    battery_window_days: int = 30
    log_level: str = "info"

settings = Settings()
```

- [ ] **Step 3: Write the failing processor test**

```python
# tests/test_processor.py
import asyncio
from unittest.mock import AsyncMock, MagicMock
from predictive_maintenance.core.processor import Processor
from predictive_maintenance.model.pm_message import PmMessage

def test_processor_publishes_pm_message():
    async def run():
        stub = AsyncMock()
        # data-api yields one battery row with voltage/soc/temp
        async def gen(_req):
            class Point:
                timestamp = MagicMock()
                timestamp.time.return_value = MagicMock()
                timestamp.time.return_value.strftime.return_value = "12:00:00"
                values = {"dynamic:battery.voltage": b'"12.50"'}
            yield Point()
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        p = Processor(stub, nats)
        await p.run("VIN1001")
        nats.publish_message.assert_awaited()
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert isinstance(msg, PmMessage)
    asyncio.run(run())
```

- [ ] **Step 4: Implement the processor**

```python
# core/processor.py
from datetime import datetime, timedelta
from grpclib.exceptions import StreamTerminatedError
from predictive_maintenance.client.generated.dataapi.v1 import TelemetryDataApiStub, GetTelemetryDataRequest
from predictive_maintenance.config.config import settings
from predictive_maintenance.config.logging import logger
from predictive_maintenance.client.nats_client import NatsConnector
from predictive_maintenance.core.detectors import detect_battery, detect_brake, detect_tires
from predictive_maintenance.model.pm_message import PmMessage


class Processor:
    def __init__(self, connector: TelemetryDataApiStub, nats: NatsConnector):
        self._dataApi = connector
        self._nats = nats

    async def run(self, vin: str):
        end = datetime.now()
        start = end - timedelta(days=settings.battery_window_days)
        request = GetTelemetryDataRequest(
            vehicle_id=vin,
            data_types=["dynamic:battery.voltage", "dynamic:battery.soc", "dynamic:battery.temp",
                        "dynamic:VELOCITY", "dynamic:acceleration_modulus_m_s2",
                        "dynamic:brake_pedal_pct", "dynamic:distance_meters",
                        "dynamic:TIRE_PRESSURE", "dynamic:TIRE_TEMP"],
            last_duration=timedelta(seconds=settings.battery_window_days * 86400),
        )
        rest, crank, brake_energy, tires = [], [], 0.0, []
        try:
            async for point in self._dataApi.get_telemetry_data(request):
                ts = point.timestamp.time().strftime("%H:%M:%S")
                v = lambda k: point.values.get(k)  # noqa: E731
                if v("dynamic:battery.voltage"):
                    rest.append((datetime.now().timestamp(), float(v("dynamic:battery.voltage").decode().strip('"'))))
                if v("dynamic:TIRE_PRESSURE") and v("dynamic:TIRE_TEMP"):
                    tires.append((datetime.now().timestamp(),
                                  float(v("dynamic:TIRE_PRESSURE").decode().strip('"')),
                                  float(v("dynamic:TIRE_TEMP").decode().strip('"')) + 273.15))
                if v("dynamic:acceleration_modulus_m_s2") and v("dynamic:VELOCITY") and v("dynamic:brake_pedal_pct"):
                    a = float(v("dynamic:acceleration_modulus_m_s2").decode().strip('"'))
                    vel = float(v("dynamic:VELOCITY").decode().strip('"'))
                    brake_pct = float(v("dynamic:brake_pedal_pct").decode().strip('"'))
                    if brake_pct > 5.0 and a > 0.5 and vel > 0.5:
                        brake_energy += 1500.0 * a * vel * settings.poll_interval_seconds  # m·a·v·dt
        except Exception as e:
            logger.error("Data poll failed", vehicle_id=vin, error=repr(e))
            return
        results = {}
        if rest:
            results["battery"] = detect_battery(rest, crank)
        if brake_energy > 0:
            results["brake"] = detect_brake(min(1.0, brake_energy / 6.0e9))  # E_budget 6 GJ
        if tires:
            results["tires"] = detect_tires(tires)
        if not self._nats.is_connected:
            self._nats.connect()
        for component, r in results.items():
            if r.severity == "healthy":
                continue  # publish only on change/band-crossing; healthy = nothing
            await self._nats.publish_message(
                subject=f"pm.{vin}.{component}",
                message=PmMessage(vin=vin, component=component, health_score=r.health_score,
                                  severity=r.severity, evidence=r.evidence,
                                  explanation=r.explanation,
                                  timestamp=datetime.now().isoformat()))
```

- [ ] **Step 5: Run processor test, then full unit suite**

Run: `uv run pytest tests/ -v`
Expected: PASS (pm_message + detectors + processor).

- [ ] **Step 6: Dockerfile + compose wiring**

`sample-services/predictive-maintenance/Dockerfile.local` (mirror trip_analyzer's, module renamed):
```dockerfile
ARG DOCKER_HUB_MIRROR=docker.io
FROM ${DOCKER_HUB_MIRROR}/python:3.13-slim AS base
RUN pip install uv
WORKDIR /app
COPY . /app
RUN uv sync
ENV PATH="/app/.venv/bin:$PATH"
CMD ["uv", "run", "uvicorn", "predictive_maintenance.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

`local-dev/docker-compose.yml` — add service (Task 9 wires `pm-demo`; the service itself lands here):
```yaml
  predictive-maintenance:
    build:
      context: ../sample-services/predictive-maintenance
      dockerfile: Dockerfile.local
    container_name: nexus-predictive-maintenance
    environment:
      - DATA_API_GRPC_ADDR=${DATA_API_GRPC_ADDR}
      - NATS_HOST=nats
      - NATS_PORT=4222
      - NATS_USER=connector
      - NATS_PASSWORD=connector-pass
      - SCHEDULED_VINS=${VIN_POOL}
      - POLL_INTERVAL_SECONDS=60
      - LOG_LEVEL=info
    depends_on:
      - data-api
    networks:
      - nexus-local
```

- [ ] **Step 7: Commit**

```bash
git add sample-services/predictive-maintenance local-dev/docker-compose.yml
git commit -m "feat(pm): detector service (poll data-api, publish pm.* alerts)"
```

---

### Task 4: Simulator degradation + trip data (Go)

**Files:**
- Modify: `sample-clients/vehicle-client/main.go` (battery state, drive state, publish loop, control handler, status reply)
- Modify: `sample-clients/vehicle-client/trip_logic.go` / `trip_route.go` (reuse for trip data; brake-event energy accumulation hooks)
- Create: `sample-clients/vehicle-client/degradation.go` (NEW: per-VIN degradation config + trajectory math)
- Test: `sample-clients/vehicle-client/degradation_test.go`

**Interfaces:**
- Consumes: existing `batteryState{voltage,current,soc,temp}`, `driveState`, `controlState.handle`, `stateLocked`.
- Produces:
  - `type DegradationConfig struct { Component string; Preset string; HorizonDays int }` with `healthy|degrading|critical` presets.
  - `func (d *DegradationConfig) BatteryAt(day float64) (vRest, vMin, rInt float64)` — the PyBaMM-informed curve shapes.
  - `func (d *DegradationConfig) TirePressureAt(day float64) (bar float64)` and `TireTempAt(day float64) float64`.
  - Brake: `driveState` gains `brakeEnergyJ float64`, `brakeWearFraction()`; `driveCycleStep` accumulates `m·a·v·Δt` on brake events (mass = 1500 kg, `E_budget = 6e9 J`).
  - Control action `{"action":"degradation","component":"battery","preset":"degrading"}`; status reply gains `"ground_truth": {"battery": {"wear_fraction":0.5,"days_to_failure":42}, ...}`.
  - `TIRE_TEMP` emitted on the telemetry path (Task 5 adds the proto field; this task wires the value).

- [ ] **Step 1: Write the failing degradation test**

```go
// degradation_test.go
package main

import (
	"math"
	"testing"
)

func TestBatteryDegradesOverHorizon(t *testing.T) {
	d := &DegradationConfig{Component: "battery", Preset: "degrading", HorizonDays: 120}
	startV, _, _ := d.BatteryAt(0)
	endV, endMin, endR := d.BatteryAt(120)
	if startV < 12.5 || endV > 12.1 {
		t.Fatalf("expected V_rest decline 12.6→~12.0, got %.2f→%.2f", startV, endV)
	}
	if endR <= endMin {
		t.Fatalf("R_int %.1f should exceed V_min %.1f", endR, endMin)
	}
}

func TestHealthyBatteryStable(t *testing.T) {
	d := &DegradationConfig{Component: "battery", Preset: "healthy", HorizonDays: 120}
	_, v, _ := d.BatteryAt(0)
	_, v2, _ := d.BatteryAt(120)
	if math.Abs(v-v2) > 0.05 {
		t.Fatalf("healthy battery drifted %.3f V, want ≤0.05", math.Abs(v-v2))
	}
}

func TestTireLeak(t *testing.T) {
	d := &DegradationConfig{Component: "tires", Preset: "degrading", HorizonDays: 60}
	p0 := d.TirePressureAt(0)
	p60 := d.TirePressureAt(60)
	if p0-p60 < 0.3 {
		t.Fatalf("expected leak ≥0.3 bar over 60d, got %.2f", p0-p60)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-clients/vehicle-client && go test -run 'TestBatteryDegrades|TestHealthyBattery|TestTireLeak' -v`
Expected: FAIL — `DegradationConfig` undefined.

- [ ] **Step 3: Implement degradation.go**

```go
// degradation.go — per-VIN degradation trajectories (PyBaMM-informed shapes).
package main

import "math"

type DegradationConfig struct {
	Component   string `json:"component"`
	Preset      string `json:"preset"` // healthy | degrading | critical
	HorizonDays int    `json:"horizon_days"`
}

func (d *DegradationConfig) norm(day float64) float64 {
	h := float64(d.HorizonDays)
	if h <= 0 {
		h = 120
	}
	return math.Max(0, math.Min(1, day/h))
}

func (d *DegradationConfig) severityFactor() float64 {
	switch d.Preset {
	case "critical":
		return 1.0
	case "degrading":
		return 0.55
	default:
		return 0.0 // healthy
	}
}

// BatteryAt returns (V_rest, V_min, R_int_mohm) at day. Curve shapes follow
// the PyBaMM lead-acid aging model offline fits: V_rest declines on a
// sqrt-ish curve (fast early sulfation, plateau, then drop), R_int rises
// ~linearly with deg.
func (d *DegradationConfig) BatteryAt(day float64) (float64, float64, float64) {
	deg := d.severityFactor() * math.Sqrt(d.norm(day))
	vRest := 12.63 - 0.63*deg // → 12.0 V at full degradation
	rInt := 9.3 + 6.0*deg     // mΩ, 9.3 baseline → ~15.3
	vMin := 10.8 - 1.3*deg    // cranking sag worsens with aging
	return vRest, vMin, rInt
}

// TirePressureAt returns bar at day (leak rate 0.2 bar/month for degrading).
func (d *DegradationConfig) TirePressureAt(day float64) float64 {
	leak := 0.2 * d.norm(day)
	return 2.3 - leak*day/30.0
}

// TireTempAt returns °C at day — 28 °C mean with ±8 °C daily cycle (India).
func (d *DegradationConfig) TireTempAt(day float64) float64 {
	return 28.0 + 8.0*math.Sin(day*2*math.Pi)
}
```

- [ ] **Step 4: Wire into main.go**

- Extend `batteryState` with `deg *DegradationConfig` and `ageDays float64`; in `publishOnce`, replace the random-walk voltage/current/temp block (main.go:1285-1297) with:
```go
battery.ageDays += float64(intervalSeconds) / 86400.0
vRest, vMin, rInt := battery.deg.BatteryAt(battery.ageDays)
battery.voltage = vRest + (mathrand.Float64()-0.5)*0.025 // ±0.025 V noise
battery.soc = 85.5 - 30*((battery.deg.severityFactor()*battery.ageDays/120.0)/1.0)
battery.temp = battery.deg.TireTempAt(battery.ageDays) // reuse temp cycle
_ = vMin
_ = rInt
```
- `driveState`: add `brakeEnergyJ float64`; in `driveCycleStep` (main.go), when `brake_pedal_pct > 5 && accelMod > 0.5 && velocity > 0.5`: `drive.brakeEnergyJ += 1500.0 * accelMod * velocity * float64(intervalSeconds)`.
- `controlState.handle`: add `degradation` action case setting `deg = &DegradationConfig{...}` on the target component (battery/tires) or all.
- `stateLocked` reply: add `"ground_truth": map[string]any{"battery": map[string]any{"wear_fraction": ..., "days_to_failure": int((1 - deg.norm(age))*...)} }` for enabled components.
- New `controlState` construction: default every VIN to a preset from env `DEGRADATION_PRESET` (default "demo": healthy for odd pool index, degrading/critical for even) so the fleet has spread.

- [ ] **Step 5: Run all Go tests**

Run: `cd sample-clients/vehicle-client && go test ./... -v`
Expected: PASS (existing + new degradation tests; `sim_test.go`, `main_test.go` unchanged pass).

- [ ] **Step 6: Commit**

```bash
git add sample-clients/vehicle-client
git commit -m "feat(pm): vehicle-simulator degradation trajectories + brake/tire accumulation + ground-truth reply"
```

---

### Task 5: TIRE_TEMP proto field + client emission

**Files:**
- Modify: `proto/vehicle_telemetry.proto` (add `optional float TIRE_TEMP = 16;`)
- Modify: `sample-clients/vehicle-client/main.go` (`buildPayloads`/powertrain report: emit `TIRE_TEMP` from `deg.TireTempAt`)
- Modify: `base-services/nats-bigtable-connector/` — **verify** the typed-field → Bigtable-qualifier mapping includes new fields (see Step 2)
- Modify: `local-dev/scripts/ingest-sample.sh` (optional seed note)

**Interfaces:**
- Consumes: Task 4 `DegradationConfig.TireTempAt`.
- Produces: `dynamic:TIRE_TEMP` qualifier in Bigtable, readable by data-api (`Processor` in Task 3 already requests it).

- [ ] **Step 1: Add the proto field**

```proto
  // Tyre temperature in °C.
  optional float TIRE_TEMP = 16;
```
Copy `proto/vehicle_telemetry.proto` into `sample-clients/vehicle-client/telemetry/` (per AGENTS.md proto workflow) and regenerate stubs (`make proto` in vehicle-client; protoc must be on PATH).

- [ ] **Step 2: Check the connector's field mapping**

Read `base-services/nats-bigtable-connector/src/` and confirm how `VehicleTelemetryData` fields map to `dynamic:*` qualifiers (the typed path). If new fields need explicit mapping (e.g. a qualifier table), add `TIRE_TEMP → dynamic:TIRE_TEMP` there. If the connector writes generic fields automatically, no change. Add the mapping and a unit test if the connector has one (`nats-bigtable-connector` has zero tests per AGENTS.md — add a focused one only if the mapping table exists).

- [ ] **Step 3: Emit TIRE_TEMP from the simulator**

In `buildPayloads`/powertrain report construction, set `TIRE_TEMP: f32(float32(battery.deg.TireTempAt(battery.ageDays)))` alongside `TIRE_PRESSURE`. Keep `TIRE_PRESSURE` real now (from `deg.TirePressureAt`) instead of the constant 2.2.

- [ ] **Step 4: Verify locally**

Run: `cd local-dev && make demo` (or `make go`), then query Bigtable for a VIN and confirm `dynamic:TIRE_PRESSURE` and `dynamic:TIRE_TEMP` columns appear:
```bash
bash scripts/query-bigtable.sh "VIN1001#" | grep -E "TIRE_PRESSURE|TIRE_TEMP"
```
Expected: both qualifiers present with realistic values.

- [ ] **Step 5: Commit**

```bash
git add proto/vehicle_telemetry.proto sample-clients/vehicle-client base-services/nats-bigtable-connector local-dev/scripts/ingest-sample.sh
git commit -m "feat(pm): TIRE_TEMP proto field + real pressure/leak emission"
```

---

### Task 6: Web client — PM SSE stream + hook

**Files:**
- Create: `sample-clients/data-web-client/src/proto/pm.proto` (copy of pm-message.proto)
- Create: `sample-clients/data-web-client/src/lib/pm-types.ts`
- Create: `sample-clients/data-web-client/src/hooks/usePmMessages.ts`
- Create: `sample-clients/data-web-client/src/app/api/pm/stream/route.ts`
- Test: `sample-clients/data-web-client/src/lib/pm-types.test.ts`

**Interfaces:**
- Consumes: `pm.proto` schema.
- Produces: `PmMessage` TS type, `parsePmMessage(raw: string): PmMessage | null` (returns null on schema failure), `severityColor(sev: string): string`, `usePmMessages(): PmMessage[]`; `/api/pm/stream` SSE.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/pm-types.test.ts
import { parsePmMessage, severityColor } from './pm-types';

describe('parsePmMessage', () => {
  it('parses a valid message', () => {
    const raw = JSON.stringify({ vin: 'VIN1001', component: 'battery', health_score: 62, severity: 'advisory', evidence: { ewma_voltage: '12.38' }, explanation: 'Resting voltage 12.38 V.', timestamp: '2026-08-09T00:00:00Z' });
    const m = parsePmMessage(raw);
    expect(m?.severity).toBe('advisory');
    expect(m?.health_score).toBe(62);
  });
  it('rejects malformed messages', () => {
    expect(parsePmMessage('not json')).toBeNull();
    expect(parsePmMessage(JSON.stringify({ vin: 'x' }))).toBeNull(); // missing fields
  });
});

describe('severityColor', () => {
  it('maps severities to colors', () => {
    expect(severityColor('healthy')).toBeDefined();
    expect(severityColor('critical')).toMatch(/red|rose/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sample-clients/data-web-client && bun run jest src/lib/pm-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pm-types.ts**

```typescript
// src/lib/pm-types.ts
export interface PmMessage {
  vin: string;
  component: 'battery' | 'brake' | 'tires';
  health_score: number;
  severity: 'healthy' | 'advisory' | 'action' | 'critical';
  evidence: Record<string, string>;
  explanation: string;
  timestamp: string;
}

const SEVERITIES = ['healthy', 'advisory', 'action', 'critical'];
const COMPONENTS = ['battery', 'brake', 'tires'];

export function parsePmMessage(raw: string): PmMessage | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.vin !== 'string' || !COMPONENTS.includes(o.component as string) ||
        typeof o.health_score !== 'number' || !SEVERITIES.includes(o.severity as string) ||
        typeof o.explanation !== 'string' || typeof o.timestamp !== 'string') {
      return null;
    }
    return o as unknown as PmMessage;
  } catch {
    return null;
  }
}

export function severityColor(sev: string): string {
  switch (sev) {
    case 'critical': return '#DC2626'; // red-600
    case 'action': return '#F97316';   // orange-500
    case 'advisory': return '#F59E0B'; // amber-500
    default: return '#22C55E';         // green-500
  }
}
```

- [ ] **Step 4: Implement the SSE route + hook (mirror scoring)**

`src/app/api/pm/stream/route.ts`: copy `src/app/api/scoring/stream/route.ts`, change the proto inline to `pm.PmMessage` with the 7 fields, subscribe `pm.*`, decode via protobufjs, `data:` lines carry the JSON of the decoded message. Auth gate (`getServerSession`) identical.

`src/hooks/usePmMessages.ts`: copy `useScoringMessages`, parse each `e.data` with `parsePmMessage`, skip nulls, prepend to list, sessionStorage key `pmMessages`, cap 100.

- [ ] **Step 5: Run tests, lint, build**

Run: `bun run jest src/lib/pm-types.test.ts && bun run lint && bun run build`
Expected: PASS all.

- [ ] **Step 6: Commit**

```bash
git add sample-clients/data-web-client/src
git commit -m "feat(pm): web client PM SSE stream + pm-types + usePmMessages hook"
```

---

### Task 7: /demo extensions — gauges, alert chips, ticker

**Files:**
- Modify: `sample-clients/data-web-client/src/components/demo/component-panel.tsx` (health gauge ring per component)
- Modify: `sample-clients/data-web-client/src/components/demo/vehicle-schematic.tsx` (alert chip on nodes)
- Modify: `sample-clients/data-web-client/src/app/demo/page.tsx` (wire `usePmMessages`, ticker strip, pass alert state)

**Interfaces:**
- Consumes: `usePmMessages()`, `severityColor`, `PmMessage` (Task 6).
- Produces: `/demo` shows live per-component health + alerts.

- [ ] **Step 1: Implement the health gauge**

In `component-panel.tsx`, add a `HealthGauge` subcomponent (SVG ring, 0–100, stroke = `severityColor` from the latest pm message for that component id) and render it in each component card. Props: `score: number | null`, `severity: string`. Data source: a new prop `health: Record<string, { score: number; severity: string }>` computed in the page from `usePmMessages()` (latest message per component, keyed by `component`).

```tsx
function HealthGauge({ score, severity }: { score: number | null; severity: string }) {
  const r = 20, c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-muted-foreground/20" />
        <circle cx="26" cy="26" r={r} fill="none" stroke={severityColor(severity)} strokeWidth="5"
                strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 26 26)" />
      </svg>
      <span className="font-mono text-lg font-semibold">{score === null ? '—' : score}</span>
    </div>
  );
}
```

- [ ] **Step 2: Implement the alert chip**

In `vehicle-schematic.tsx`, when the active component has an active alert (severity ≠ healthy), render a pulsing dot badge at the node position with `severityColor`; on click, keep existing node behavior (which already selects the component — the /pm jump is a separate control added in Task 8's drill-down link).

- [ ] **Step 3: Wire the page**

In `src/app/demo/page.tsx`:
```tsx
const pmMessages = usePmMessages();
const latestByComponent = useMemo(() => {
  const m = new Map<string, PmMessage>();
  for (const msg of pmMessages) if (!m.has(msg.component)) m.set(msg.component, msg);
  return m;
}, [pmMessages]);
const health = Object.fromEntries([...latestByComponent.entries()].map(([k, v]) => [k, { score: v.health_score, severity: v.severity }]));
```
Pass `health` to `<ComponentPanel>`. Add a ticker strip under the pipeline (or above ChartGrid):
```tsx
{pmMessages.length > 0 && (
  <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-border/60 px-3 py-2 text-xs">
    <span className="font-semibold tracking-wider text-muted-foreground">PM ALERTS</span>
    <div className="flex gap-4 overflow-x-auto">
      {pmMessages.slice(0, 8).map((m, i) => (
        <span key={i} className="whitespace-nowrap font-mono">
          <span style={{ color: severityColor(m.severity) }}>{m.severity.toUpperCase()}</span>
          <span className="text-muted-foreground"> · {m.vin} · {m.component} · {m.explanation}</span>
        </span>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Verify**

Run: `cd sample-clients/data-web-client && bun run lint && bun run build`
Then local smoke: `make demo` + start simulator, confirm gauges populate and a degrading VIN shows an amber/red chip within a poll cycle (60 s).

- [ ] **Step 5: Commit**

```bash
git add sample-clients/data-web-client/src
git commit -m "feat(pm): /demo health gauges, alert chips, PM alert ticker"
```

---

### Task 8: /pm page — fleet matrix, alert feed, drill-down

**Files:**
- Create: `sample-clients/data-web-client/src/components/pm/pm-health-matrix.tsx`
- Create: `sample-clients/data-web-client/src/components/pm/pm-alert-feed.tsx`
- Create: `sample-clients/data-web-client/src/components/pm/pm-drill-down.tsx`
- Create: `sample-clients/data-web-client/src/app/pm/page.tsx`
- Modify: `sample-clients/data-web-client/src/components/sidebar.tsx` (PM nav entry)
- Create: `sample-clients/data-web-client/public/pm-validation.json`

**Interfaces:**
- Consumes: `usePmMessages`, `PmMessage`, `severityColor` (Task 6); `/api/telemetry/[vin]/route.ts` + `/api/demo/vehicles` for the matrix VIN list.
- Produces: `/pm` page (fleet health matrix, alert feed, drill-down w/ math + predicted-vs-actual, validation card).

- [ ] **Step 1: Create pm-validation.json**

```json
{
  "generated": "2026-08-09",
  "simulated_vins": 20,
  "components": {
    "battery": { "precision": 0.82, "recall": 0.75, "mean_lead_days": 21 },
    "brake":   { "precision": 0.9,  "recall": 0.85, "mean_lead_days": 34 },
    "tires":   { "precision": 0.8,  "recall": 0.7,  "mean_lead_days": 12 }
  }
}
```
(Placeholder values — replace with real evaluator output in Task 9.)

- [ ] **Step 2: Implement pm-health-matrix.tsx**

Props: `vins: string[]`, `messages: PmMessage[]`. Rows = VINs (fetch `/api/demo/vehicles` in the page), columns = `['battery','brake','tires']`; each cell = latest `health_score` for that vin+component (else `—`), background tinted `severityColor`. Click a cell → drill-down (`setSelected({vin, component})`).

- [ ] **Step 3: Implement pm-alert-feed.tsx**

Props: `messages: PmMessage[]`. Render newest-first list: severity badge (colored), `vin · component · timestamp`, `explanation`, and an `<details>` with the `evidence` JSON. Cap 50 with "show more".

- [ ] **Step 4: Implement pm-drill-down.tsx**

Props: `vin`, `component`, `messages: PmMessage[]`. For the selected vin+component:
- Degradation trend chart via existing `useTelemetryData({vin, range:'7d'})` + `TelemetryChart`/`SignalChart`, filtered to the component's sensors (reuse `componentSeries` logic from the demo page) with a threshold line overlay (e.g. 12.4 V for battery from `evidence`).
- Math panel: render the latest message's `evidence` as labeled key/value rows (ewma_voltage, slope_mv_day, threshold…).
- Predicted-vs-actual: from the simulator `ground_truth` status reply (extend `/api/demo/vehicle` response typing to include `ground_truth`) — show "predicted lead: N days" (from message timestamp vs. the failure date implied by ground truth) vs "actual days-to-failure" (ground truth), clearly labeled "simulator ground truth".

- [ ] **Step 5: Wire /pm page + sidebar**

`src/app/pm/page.tsx`: `usePmMessages` + VIN list; layout = overview cards (counts per severity per component) + `<PmHealthMatrix>` + `<PmAlertFeed>` + selected `<PmDrillDown>`; a `PmValidationCard` reads `public/pm-validation.json` (fetch) and renders the precision/recall/lead table with the "simulator ground truth" label.

`sidebar.tsx`: add a nav item `Predictive Maintenance` → `/pm` (match existing NavLink styling).

- [ ] **Step 6: Verify**

Run: `cd sample-clients/data-web-client && bun run lint && bun run build`
Smoke: `make demo` + simulator, navigate `/pm`, confirm matrix populates from the live pm.* stream, drill-down renders math + chart, validation card shows numbers.

- [ ] **Step 7: Commit**

```bash
git add sample-clients/data-web-client/src sample-clients/data-web-client/public/pm-validation.json
git commit -m "feat(pm): /pm fleet-health page (matrix, alert feed, drill-down, validation)"
```

---

### Task 9: Makefile, offline evaluator, e2e assertion, demo script

**Files:**
- Modify: `local-dev/Makefile` (+ `pm-demo` target)
- Create: `sample-services/predictive-maintenance/scripts/evaluate_detectors.py`
- Create: `sample-services/predictive-maintenance/scripts/calibrate_battery_curve.py` (optional PyBaMM fit)
- Modify: `local-dev/scripts/test-local-flow.sh` (+ pm loop assertion)
- Modify: `sample-clients/data-web-client/public/pm-validation.json` (real evaluator numbers)

**Interfaces:**
- Consumes: Task 3 service, Task 4 sim, Task 8 page.
- Produces: `make pm-demo` (one-command showcase), `evaluate_detectors.py` output JSON consumed by the /pm validation card, e2e assertion for the pm loop.

- [ ] **Step 1: Makefile target**

```makefile
.PHONY: ... pm-demo
pm-demo:
	@bash go.sh
	docker compose --env-file .env.base-services --env-file .env.sample-services up -d vehicle-simulator predictive-maintenance
	@echo "Opening Predictive Maintenance dashboard..."
	@open http://localhost:3000/pm 2>/dev/null || true
```

- [ ] **Step 2: Offline evaluator script**

`scripts/evaluate_detectors.py` (run after a sim soak, e.g. 20 VINs × 60 days of accelerated sim):
- Read the simulator's ground-truth labels (the `ground_truth` from status replies, or a labels CSV the sim writes under `local-dev/data/`).
- Re-run detectors over data-api history (same poll as Task 3) → alert list.
- Compute per-component precision, recall, mean detection lead time (days between first alert and ground-truth failure).
- Write `sample-clients/data-web-client/public/pm-validation.json` in the Task 8 shape.
Include a `--vins` arg and a `--soak-days` arg; document the run in the script's docstring. No tests (one-off tool).

- [ ] **Step 3: Optional PyBaMM calibration script**

`scripts/calibrate_battery_curve.py` — docstring + `uv run --with pybamm` path: run `pybamm.lead_acid.Full`/`LOQS` at 25/35/45 °C, fit the degradation shapes (`V_rest`, `R_int` trajectories) to the `DegradationConfig.BatteryAt` parameterization, emit `degradation_config.json`. Checked-in defaults remain the fallback. One-off tool; no tests.

- [ ] **Step 4: e2e assertion**

In `local-dev/scripts/test-local-flow.sh`, after the existing ingest assertion, add:
```bash
# Predictive-maintenance loop: detector publishes pm.* after data lands.
sleep 65  # one poll cycle (POLL_INTERVAL_SECONDS=60)
SUBJECT_LINE=$(docker compose logs --tail 200 predictive-maintenance 2>/dev/null | grep -m1 "pm\." || true)
if [ -z "$SUBJECT_LINE" ]; then
  echo "FAIL: predictive-maintenance did not publish pm.* (no health anomaly or service down)" >&2
  exit 1
fi
echo "PASS: predictive-maintenance published $(echo "$SUBJECT_LINE" | sed -E 's/.*(pm\.[^ ]+).*/\1/')"
```
Note in a comment: healthy VINs publish nothing by design (Task 3 §publish-cadence) — to make the assertion deterministic, run it with `DEGRADATION_PRESET=critical` for at least one pool VIN, or assert on "service polled data-api" log line instead. Prefer the latter for stability:
```bash
docker compose logs --tail 200 predictive-maintenance 2>/dev/null | grep -q "Data poll failed" && { echo "FAIL: detector errored" >&2; exit 1; } || true
docker compose logs --tail 200 predictive-maintenance 2>/dev/null | grep -q "Polling" && echo "PASS: detector polling loop alive" || { echo "FAIL: detector not polling" >&2; exit 1; }
```

- [ ] **Step 5: Run the full verification**

Run: `cd local-dev && make pm-demo`
Then:
- `make test` (existing suite still passes — the pm assertion is additive).
- `curl -s localhost:3000/pm | grep -i "predictive"` (page serves).
- Confirm simulator logs show degradation values and `/pm` shows alerts for degrading VINs.

- [ ] **Step 6: Update pm-validation.json with real numbers**

Run `python scripts/evaluate_detectors.py --vins VIN1001,VIN1002,...` after a soak, replace the placeholder JSON with the real precision/recall/lead numbers, commit.

- [ ] **Step 7: Commit**

```bash
git add local-dev sample-services/predictive-maintenance/scripts sample-clients/data-web-client/public/pm-validation.json
git commit -m "feat(pm): pm-demo target, offline evaluator, e2e assertion, real validation numbers"
```

---

## Self-Review Notes (filled during plan writing)

**Spec coverage:** every spec section maps to a task — architecture (§2) → Tasks 1–6; simulator (§3) → Tasks 4–5; detector (§4) → Tasks 1–3; /demo (§5) → Task 7; /pm (§5) → Task 8; testing/demo (§6) → Tasks 2, 4, 9. Non-goals untouched (no LLM, no cloud, no per-wheel tire).
**No placeholders:** every task carries real code or a concrete command; the only "placeholder" is `pm-validation.json`'s initial values, explicitly replaced in Task 9 Step 6 with real evaluator output (not a TBD — a documented two-phase value).
**Type consistency:** `PmMessage` fields match between proto (Task 1), betterproto stub (Task 1), Go `PmMessage`-equivalent JSON on the wire (Task 3 uses the proto stub), TS `PmMessage` (Task 6), and the JSON examples — `component` values `battery|brake|tires`, `severity` values `healthy|advisory|action|critical`, `health_score` 0–100. `detect_battery` returns `DetectorResult(health_score, severity, evidence, explanation)` in Task 2 and Task 3 consumes exactly that. `DegradationConfig.{BatteryAt,TirePressureAt,TireTempAt}` signatures match between Task 4 and Task 5. `/api/pm/stream` (Task 6) and `usePmMessages` (Task 6) share the same subject `pm.*`.

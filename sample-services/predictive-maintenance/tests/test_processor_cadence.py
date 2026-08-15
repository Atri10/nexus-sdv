import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from predictive_maintenance.core.processor import Processor


def _point(t: datetime, **kv):
    # Build the values dict in the enclosing scope: a comprehension inside the
    # class body cannot see an outer parameter of the same name.
    vals = {k: bytes(f'"{v}"', "utf-8") for k, v in kv.items()}

    class Point:
        timestamp = t
        values = vals
    return Point()


def _healthy_point(t: datetime, voltage: str = "12.50"):
    return _point(t, **{"dynamic:battery.voltage": voltage})


def test_processor_publishes_healthy_state():
    """Demo cadence: every poll publishes current state for every VIN,
    healthy included (the /pm live board needs a state message per poll)."""
    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for i in range(5):
                yield _healthy_point(base + timedelta(minutes=10 * i), "12.50")
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        nats.publish_message.assert_awaited()
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert msg.severity == "healthy"
    asyncio.run(run())


def test_processor_poll_exception_returns_without_publishing():
    """Data-poll failure must log and return; never crash the loop."""
    async def run():
        stub = AsyncMock()

        async def gen(_req):
            raise RuntimeError("data-api unreachable")
            yield  # pragma: no cover
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        nats.publish_message.assert_not_awaited()
    asyncio.run(run())


def test_processor_brake_energy_uses_sample_spacing():
    """Brake energy must integrate the per-tick m·a·v·dt over the real
    point-to-point dt (≈5 s simulator ticks), not the 60 s poll interval."""
    import predictive_maintenance.core.processor as mod

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        # Two consecutive braking rows, 5 s apart, decelerating 20 → 15 m/s
        # (a = -1 m/s²). Per-tick energy = m·|a|·v_avg·dt = 1500·1·17.5·5 = 131250 J.
        rows = [
            _point(base, **{"dynamic:VELOCITY": 20.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
            _point(base + timedelta(seconds=5), **{"dynamic:VELOCITY": 15.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
        ]

        async def gen(_req):
            for r in rows:
                yield r
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        # Shrunken budget makes 131250 J land at 0.875 wear → advisory alert
        # on pm.VIN1001.brake.
        nats.publish_message.assert_awaited()
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.brake"
        assert msg.severity == "advisory"
        assert msg.evidence["wear_fraction"] == "0.875"
    old_budget = mod.BRAKE_ENERGY_BUDGET_J
    mod.BRAKE_ENERGY_BUDGET_J = 150000.0  # 131250 J → 0.875 wear
    try:
        asyncio.run(run())
    finally:
        mod.BRAKE_ENERGY_BUDGET_J = old_budget


def test_processor_brake_energy_without_poll_interval_inflation():
    """Regression guard for finding 3: with a 60 s poll interval configured,
    a 5 s-spaced braking pair must accumulate 131250 J (sample-spaced), NOT
    the old poll-interval-inflated value that saturates at 6e9 J."""
    import predictive_maintenance.core.processor as mod

    async def run():
        from predictive_maintenance.config.config import settings
        old_interval = settings.poll_interval_seconds
        settings.poll_interval_seconds = 60
        try:
            stub = AsyncMock()
            base = datetime(2026, 8, 1, tzinfo=timezone.utc)
            rows = [
                _point(base, **{"dynamic:VELOCITY": 20.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
                _point(base + timedelta(seconds=5), **{"dynamic:VELOCITY": 15.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
            ]

            async def gen(_req):
                for r in rows:
                    yield r
            stub.get_telemetry_data = gen
            nats = AsyncMock()
            nats.is_connected = True
            p = Processor(stub, nats)
            await p.run("VIN1001")
            nats.publish_message.assert_awaited()
            subject, msg = nats.publish_message.await_args.args
            assert subject == "pm.VIN1001.brake"
            # 0.875 (not 1.000): with the old code the energy would have been
            # 1500·|a|·v·60 = 1.575e6 J → capped wear 1.000 → action.
            assert msg.evidence["wear_fraction"] == "0.875"
            assert msg.severity == "advisory"
        finally:
            settings.poll_interval_seconds = old_interval
    old_budget = mod.BRAKE_ENERGY_BUDGET_J
    mod.BRAKE_ENERGY_BUDGET_J = 150000.0
    try:
        asyncio.run(run())
    finally:
        mod.BRAKE_ENERGY_BUDGET_J = old_budget


def test_processor_requests_only_existing_qualifiers():
    """Regression guard for finding 1: the poll must request exactly the
    qualifiers the pipeline writes today — uppercase BRAKE_PEDAL_PCT (not
    lowercase), no invented acceleration_modulus_m_s2 / distance_meters,
    and no battery.soc (unused by the processor)."""
    async def run():
        stub = AsyncMock()
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        seen = []

        async def gen(req):
            seen.append(list(req.data_types))
            if False:
                yield
        stub.get_telemetry_data = gen
        await p.run("VIN1001")
        requested = seen[0]
        assert "dynamic:BRAKE_PEDAL_PCT" in requested
        assert "dynamic:brake_pedal_pct" not in requested
        assert "dynamic:acceleration_modulus_m_s2" not in requested
        assert "dynamic:distance_meters" not in requested
        assert "dynamic:battery.soc" not in requested
        assert "dynamic:VELOCITY" in requested
        assert "dynamic:TIRE_PRESSURE" in requested
        assert "dynamic:TIRE_TEMP" in requested
        assert "dynamic:battery.voltage" in requested
        assert "dynamic:battery.temp" in requested
        # Per-wheel columns are requested too.
        for w in ("FL", "FR", "RL", "RR"):
            assert f"dynamic:TIRE_PRESSURE.{w}" in requested
            assert f"dynamic:TIRE_TEMP.{w}" in requested
            assert f"dynamic:BRAKE_WEAR.{w}" in requested
    asyncio.run(run())


def test_processor_nats_connect_awaited_before_publish():
    """Finding 4: when NATS is not yet connected, Processor must await
    connect() (awaitable dial) before publishing — never raise on a None nc."""
    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for i in range(5):
                yield _healthy_point(base + timedelta(minutes=10 * i), "12.10")
        stub.get_telemetry_data = gen

        connect_calls = []

        class FakeNats:
            is_connected = False

            async def connect(self):
                connect_calls.append(1)
                self.is_connected = True

            async def publish_message(self, subject, message):
                pass

        nats = FakeNats()
        p = Processor(stub, nats)
        await p.run("VIN1001")
        # Healthy VIN → no publish, but connect was still awaited (and only once).
        assert connect_calls == [1]
    asyncio.run(run())


def test_processor_skips_publish_when_nats_unavailable():
    """Finding 4: a failed connect must log + skip publish, not raise."""
    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for i in range(5):
                yield _healthy_point(base + timedelta(minutes=10 * i), "12.10")
        stub.get_telemetry_data = gen

        class FakeNats:
            is_connected = False

            async def connect(self):
                raise RuntimeError("nats unreachable")

            async def publish_message(self, subject, message):
                raise AssertionError("must not publish")

        nats = FakeNats()
        p = Processor(stub, nats)
        # Must not raise.
        await p.run("VIN1001")
    asyncio.run(run())


def _make_processor(stub, nats):
    return Processor(stub, nats)


class _Result:
    def __init__(self, health_score, severity):
        self.health_score = health_score
        self.severity = severity
        self.evidence = {}
        self.explanation = ""


def test_processor_publishes_every_poll():
    """Demo cadence: every poll publishes current state for every component
    (healthy + non-healthy, unchanged included) so the /pm live board always
    reflects current health."""
    import predictive_maintenance.core.processor as mod

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for _ in range(5):
                yield _healthy_point(base, "12.10")

        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = _make_processor(stub, nats)

        mod.detect_battery = lambda *a, **k: _Result(25, "action")
        await p.run("VIN1001")
        assert nats.publish_message.await_count == 1
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert msg.severity == "action"

        # Poll 2: identical result → STILL publishes (live-state board).
        nats.publish_message.reset_mock()
        await p.run("VIN1001")
        assert nats.publish_message.await_count == 1
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert msg.severity == "action"
    asyncio.run(run())


def test_processor_publishes_healthy_and_nonhealthy():
    """Demo cadence: healthy and non-healthy VINs both publish (the board
    shows green vehicles too)."""
    import predictive_maintenance.core.processor as mod

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for _ in range(5):
                yield _healthy_point(base, "12.50")

        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = _make_processor(stub, nats)

        mod.detect_battery = lambda *a, **k: _Result(100, "healthy")
        await p.run("VIN1001")
        assert nats.publish_message.await_count == 1
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert msg.severity == "healthy"
    asyncio.run(run())


def test_processor_publishes_both_components_first_poll():
    """Demo cadence: a poll with battery AND brake results publishes both."""
    import predictive_maintenance.core.processor as mod

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            out = [_healthy_point(base + timedelta(minutes=10 * i), "12.10") for i in range(5)]
            brake_start = base + timedelta(hours=1)
            out.append(_point(brake_start, **{"dynamic:VELOCITY": 20.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}))
            out.append(_point(brake_start + timedelta(seconds=5), **{"dynamic:VELOCITY": 15.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}))
            for r in out:
                yield r

        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = _make_processor(stub, nats)

        mod.detect_battery = lambda *a, **k: _Result(45, "action")
        mod.detect_brake = lambda *a, **k: _Result(20, "action")
        await p.run("VIN1001")
        subjects = {args[0] for args, _ in nats.publish_message.await_args_list}
        assert "pm.VIN1001.battery" in subjects
        assert "pm.VIN1001.brake" in subjects
    asyncio.run(run())


def _wheel_point(t: datetime, wheel: str, pressure: float, temp_c: float, wear: float):
    """One chassis row carrying the per-wheel tire + brake columns for the
    given wheel (plus the shared single-channel columns)."""
    return _point(
        t,
        **{
            "dynamic:TIRE_PRESSURE": pressure,
            "dynamic:TIRE_TEMP": temp_c,
            "dynamic:TIRE_PRESSURE." + wheel: pressure,
            "dynamic:TIRE_TEMP." + wheel: temp_c,
            "dynamic:BRAKE_WEAR." + wheel: wear,
        },
    )


def test_processor_per_wheel_tires_and_brakes():
    """Per-wheel columns flow to per-wheel detectors: FL flat tire + worn pad
    publish on pm.VIN1001.tires.FL / pm.VIN1001.brake.FL; healthy FR corners
    publish on their own subjects. No single-channel pm.VIN1001.tires /
    pm.VIN1001.brake when per-wheel data is present."""
    import predictive_maintenance.core.processor as mod
    import predictive_maintenance.core.detectors as det_mod
    real_detect_brake = det_mod.detect_brake  # sibling tests may have patched mod.detect_brake
    mod.detect_brake = real_detect_brake

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        days = 30
        # FL pressure collapses 2.3 -> 1.0 bar over the window (flat);
        # FR stays at 2.3. Both wheels carry BRAKE_WEAR (FL 0.9, FR 0.1).
        rows = []
        for i in range(days):
            fl_p = 2.3 - 1.3 * i / days
            rows.append(_wheel_point(base + timedelta(hours=6 * i), "FL", fl_p, 30.0, 0.9))
            rows.append(_wheel_point(base + timedelta(hours=6 * i), "FR", 2.3, 30.0, 0.1))
        # FL needs >= 14 compensated samples -> 30 rows is fine.

        async def gen(_req):
            for r in rows:
                yield r
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        subjects = {args[0] for args, _ in nats.publish_message.await_args_list}
        assert "pm.VIN1001.tires.FL" in subjects
        assert "pm.VIN1001.brake.FL" in subjects
        assert "pm.VIN1001.tires.FR" in subjects
        assert "pm.VIN1001.brake.FR" in subjects
        # No single-channel legacy subjects when per-wheel data exists.
        assert "pm.VIN1001.tires" not in subjects
        assert "pm.VIN1001.brake" not in subjects
        # FL flat tire is critical with evidence carrying the wheel label.
        msgs = {args[0]: args[1] for args, _ in nats.publish_message.await_args_list}
        fl_tire = msgs["pm.VIN1001.tires.FL"]
        assert fl_tire.severity == "critical"
        assert fl_tire.evidence["wheel"] == "FL"
        fl_brake = msgs["pm.VIN1001.brake.FL"]
        assert fl_brake.severity == "advisory"  # wear 0.9 > 0.8 → advisory
        assert fl_brake.evidence["pad"] == "FL"
        fr_tire = msgs["pm.VIN1001.tires.FR"]
        assert fr_tire.severity == "healthy"
        fr_brake = msgs["pm.VIN1001.brake.FR"]
        assert fr_brake.severity == "healthy"
    try:
        asyncio.run(run())
    finally:
        mod.detect_brake = real_detect_brake


def test_processor_tires_fallback_when_no_per_wheel_columns():
    """Missing TIRE_PRESSURE.{wheel} columns (older sim / mixed history)
    falls back to the single-channel TIRE_PRESSURE on pm.VIN1001.tires."""
    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        days = 30
        rows = []
        for i in range(days):
            # Legacy single-channel pressure collapsing to 1.0 bar; NO
            # per-wheel columns and no BRAKE_WEAR.* at all.
            rows.append(_point(
                base + timedelta(hours=6 * i),
                **{"dynamic:TIRE_PRESSURE": 2.3 - 1.3 * i / days,
                   "dynamic:TIRE_TEMP": 30.0},
            ))

        async def gen(_req):
            for r in rows:
                yield r
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        subjects = {args[0] for args, _ in nats.publish_message.await_args_list}
        assert "pm.VIN1001.tires" in subjects  # fallback subject
        assert not any(s.startswith("pm.VIN1001.tires.") for s in subjects)
        msgs = {args[0]: args[1] for args, _ in nats.publish_message.await_args_list}
        assert msgs["pm.VIN1001.tires"].severity == "critical"
    asyncio.run(run())


def test_processor_brake_fallback_when_no_brake_wear_columns():
    """Missing BRAKE_WEAR.{wheel} columns keeps the legacy energy-accumulator
    brake on pm.VIN1001.brake."""
    import predictive_maintenance.core.processor as mod

    async def run():
        stub = AsyncMock()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        rows = [
            _point(base, **{"dynamic:VELOCITY": 20.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
            _point(base + timedelta(seconds=5), **{"dynamic:VELOCITY": 15.0, "dynamic:BRAKE_PEDAL_PCT": 40.0}),
        ]

        async def gen(_req):
            for r in rows:
                yield r
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        subjects = {args[0] for args, _ in nats.publish_message.await_args_list}
        assert "pm.VIN1001.brake" in subjects  # energy-accumulator fallback
        assert not any(s.startswith("pm.VIN1001.brake.") for s in subjects)
    old_budget = mod.BRAKE_ENERGY_BUDGET_J
    mod.BRAKE_ENERGY_BUDGET_J = 150000.0  # 131250 J → 0.875 wear
    try:
        asyncio.run(run())
    finally:
        mod.BRAKE_ENERGY_BUDGET_J = old_budget

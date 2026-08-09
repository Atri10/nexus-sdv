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


def test_processor_does_not_publish_healthy():
    """Publish cadence: healthy VINs publish nothing."""
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
        nats.publish_message.assert_not_awaited()
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

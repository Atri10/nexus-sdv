import asyncio
from unittest.mock import AsyncMock, MagicMock
from predictive_maintenance.core.processor import Processor


def _healthy_point(voltage: str = "12.50"):
    class Point:
        timestamp = MagicMock()
        timestamp.time.return_value = MagicMock()
        timestamp.time.return_value.strftime.return_value = "12:00:00"
        values = {"dynamic:battery.voltage": bytes(f'"{voltage}"', "utf-8")}
    return Point()


def test_processor_does_not_publish_healthy():
    """Publish cadence: healthy VINs publish nothing."""
    async def run():
        stub = AsyncMock()

        async def gen(_req):
            for _ in range(5):
                yield _healthy_point("12.50")
        stub.get_telemetry_data = gen
        nats = AsyncMock()
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
        p = Processor(stub, nats)
        await p.run("VIN1001")
        nats.publish_message.assert_not_awaited()
    asyncio.run(run())

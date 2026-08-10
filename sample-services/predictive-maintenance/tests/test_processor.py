import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from predictive_maintenance.core.processor import Processor
from predictive_maintenance.model.pm_message import PmMessage


def _battery_point(t: datetime, voltage: str):
    class Point:
        timestamp = t
        values = {"dynamic:battery.voltage": bytes(f'"{voltage}"', "utf-8")}
    return Point()


def test_processor_publishes_pm_message():
    async def run():
        stub = AsyncMock()
        # data-api yields 5 battery rows with a voltage below the action
        # threshold → detect_battery returns critical → pm alert published.
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)

        async def gen(_req):
            for i in range(5):
                yield _battery_point(base + timedelta(minutes=10 * i), "12.10")
        stub.get_telemetry_data = gen
        nats = AsyncMock()
        nats.is_connected = True
        p = Processor(stub, nats)
        await p.run("VIN1001")
        nats.publish_message.assert_awaited()
        subject, msg = nats.publish_message.await_args.args
        assert subject == "pm.VIN1001.battery"
        assert isinstance(msg, PmMessage)
    asyncio.run(run())

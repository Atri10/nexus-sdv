import asyncio
from unittest.mock import AsyncMock, MagicMock
from predictive_maintenance.core.processor import Processor
from predictive_maintenance.model.pm_message import PmMessage


def test_processor_publishes_pm_message():
    async def run():
        stub = AsyncMock()
        # data-api yields 5 battery rows with a voltage below the action
        # threshold → detect_battery returns critical → pm alert published.
        async def gen(_req):
            class Point:
                timestamp = MagicMock()
                timestamp.time.return_value = MagicMock()
                timestamp.time.return_value.strftime.return_value = "12:00:00"
                values = {"dynamic:battery.voltage": b'"12.10"'}
            for _ in range(5):
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

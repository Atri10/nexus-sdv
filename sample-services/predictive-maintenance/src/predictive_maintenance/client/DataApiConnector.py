import asyncio

from grpclib.client import Channel

from predictive_maintenance.client.generated.dataapi.v1 import TelemetryDataApiStub
from predictive_maintenance.config.config import settings
from predictive_maintenance.config.logging import logger


class DataApiConnector:
    def __init__(self):
        self._channel: Channel | None = None
        self.client: TelemetryDataApiStub | None = None

    async def is_healthy(self) -> bool:
        logger.debug("data_api_healthcheck_started", target=settings.data_api_grpc_addr)
        if not self._channel:
            logger.error("data_api_channel_not_initialized", target=settings.data_api_grpc_addr)
            return False

        try:
            await asyncio.wait_for(self._channel.__connect__(), timeout=15)
            logger.debug("data_api_healthcheck_succeeded", target=settings.data_api_grpc_addr)
            return True
        except Exception:
            logger.exception("data_api_healthcheck_failed", target=settings.data_api_grpc_addr)
            return False

    async def connect(self):
        """Initializes the connection to the external gRPC service."""
        logger.info("data_api_connecting", target=settings.data_api_grpc_addr)
        host, port = settings.data_api_grpc_addr.split(":")

        self._channel = Channel(host, int(port))
        self.client = TelemetryDataApiStub(self._channel)

    def get_client(self) -> TelemetryDataApiStub:
        return self.client

    async def close(self):
        """Gracefully closes the channel."""
        if self._channel:
            self._channel.close()
            logger.info("data_api_connection_closed")

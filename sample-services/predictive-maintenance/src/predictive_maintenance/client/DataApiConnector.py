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
        logger.info(f"Checking connection to Data-Api", target=settings.data_api_grpc_addr)
        if not self._channel:
            logger.error(f"Channel not initialized", target=settings.data_api_grpc_addr)
            return False

        try:
            await asyncio.wait_for(self._channel.__connect__(), timeout=15)
            logger.info(f"Successfully connected to Data-API", target=settings.data_api_grpc_addr)
            return True
        except (asyncio.TimeoutError, Exception):
            logger.error(f"Could not establish connection to Data-Api", target=settings.data_api_grpc_addr)
            return False

    async def connect(self):
        """Initializes the connection to the external gRPC service."""
        logger.info(f"Initializing connection with Data-Api: {settings.data_api_grpc_addr}",
                    target=settings.data_api_grpc_addr)
        host, port = settings.data_api_grpc_addr.split(":")

        self._channel = Channel(host, int(port))
        self.client = TelemetryDataApiStub(self._channel)

    def get_client(self) -> TelemetryDataApiStub:
        return self.client

    async def close(self):
        """Gracefully closes the channel."""
        if self._channel:
            self._channel.close()
            logger.info("gRPC channel closed")

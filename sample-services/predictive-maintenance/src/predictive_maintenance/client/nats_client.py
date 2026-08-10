import asyncio
from pathlib import Path

import nats
from nats.js import JetStreamContext

from predictive_maintenance.config.config import settings
from predictive_maintenance.config.logging import logger
from predictive_maintenance.model.pm_message import PmMessage


class NatsConnector:
    def __init__(self):
        self.nc = None
        self.js: JetStreamContext | None = None

    async def connect(self):
        # Await the background dial so callers can't race it: publish_message
        # needs self.nc to exist. Re-entrant (Processor re-connects per run) —
        # reuse an in-flight dial and never spawn a duplicate task.
        if getattr(self, "_connect_task", None) is not None and not self._connect_task.done():
            await self._connect_task
            return
        self._connect_task = asyncio.create_task(self._do_connect())
        try:
            await self._connect_task
        except Exception:
            self._connect_task = None  # allow a future retry
            raise

    async def _do_connect(self):
        logger.info("Connecting to NATS...", nats_host=settings.nats_host, nats_port=settings.nats_port)
        nats_url = f'nats://{settings.nats_host}:{settings.nats_port}'
        try:
            self.nc = await nats.connect(
                servers=[nats_url],
                user=settings.nats_user,
                password=settings.nats_password,
                error_cb=self._error_cb,
                disconnected_cb=self._disconnected_cb,
                reconnected_cb=self._reconnected_cb,
                reconnect_time_wait=10,
                max_reconnect_attempts=5,
                connect_timeout=10,
            )
            # Initialize JetStream for durable messaging
            self.js = self.nc.jetstream()
            logger.info("NATS connected", url=nats_url, user=settings.nats_user)
        except Exception as e:
            logger.error("NATS connection failed", url=nats_url, user=settings.nats_user, error=str(e))
            raise e

    async def publish_message(self, subject: str, message: PmMessage):
        logger.info("Publishing Message: ", message=message)
        raw_bytes = message.SerializeToString()
        await self.nc.publish(subject, raw_bytes)
        await self.nc.flush()
        logger.debug(f"[NATS] Telemetry sent to {subject}, bytes: {raw_bytes}, {len(raw_bytes)}")

    async def close(self):
        # 1. Cancel the background connection task if it's still running
        task = getattr(self, '_connect_task', None)
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                logger.info("NATS background connection task cancelled")

        # 2. Drain and close the actual connection if it exists
        if self.nc and self.nc.is_connected:
            await self.nc.drain()
            logger.info("NATS connection drained")
        elif self.nc:
            await self.nc.close()
            logger.info("NATS connection closed")

    # Callbacks for GKE observability
    async def _error_cb(self, e):
        logger.error("NATS error", error=str(e))

    async def _disconnected_cb(self):
        logger.warning("NATS disconnected")

    async def _reconnected_cb(self):
        logger.info("NATS reconnected")

    @property
    def is_connected(self) -> bool:
        return self.nc is not None and self.nc.is_connected

import asyncio

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
        logger.info(
            "nats_connecting",
            host=settings.nats_host,
            port=settings.nats_port,
            user=settings.nats_user,
        )
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
            logger.info(
                "nats_connected",
                host=settings.nats_host,
                port=settings.nats_port,
                user=settings.nats_user,
            )
        except Exception:
            logger.exception(
                "nats_connection_failed",
                host=settings.nats_host,
                port=settings.nats_port,
                user=settings.nats_user,
            )
            raise

    async def publish_message(self, subject: str, message: PmMessage):
        raw_bytes = message.SerializeToString()
        logger.debug(
            "pm_message_publishing",
            subject=subject,
            component=message.component,
            health_score=message.health_score,
            severity=message.severity,
            payload_bytes=len(raw_bytes),
        )
        await self.nc.publish(subject, raw_bytes)
        await self.nc.flush()
        logger.debug(
            "pm_message_published",
            subject=subject,
            payload_bytes=len(raw_bytes),
        )

    async def close(self):
        # 1. Cancel the background connection task if it's still running
        task = getattr(self, '_connect_task', None)
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                logger.info("nats_background_connection_cancelled")

        # 2. Drain and close the actual connection if it exists
        if self.nc and self.nc.is_connected:
            await self.nc.drain()
            logger.info("nats_connection_drained")
        elif self.nc:
            await self.nc.close()
            logger.info("nats_connection_closed")

    # Callbacks for GKE observability
    async def _error_cb(self, e):
        logger.error("nats_error", error=str(e))

    async def _disconnected_cb(self):
        logger.warning("nats_disconnected")

    async def _reconnected_cb(self):
        logger.info("nats_reconnected")

    @property
    def is_connected(self) -> bool:
        return self.nc is not None and self.nc.is_connected

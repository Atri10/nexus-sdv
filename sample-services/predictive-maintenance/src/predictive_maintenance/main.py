from contextlib import asynccontextmanager
from typing import List, Union

from fastapi import FastAPI

from predictive_maintenance.api.router import api_router
from predictive_maintenance.client.DataApiConnector import DataApiConnector
from predictive_maintenance.client.nats_client import NatsConnector
from predictive_maintenance.config.config import settings
from predictive_maintenance.config.logging import setup_logging, logger
from predictive_maintenance.core.processor import Processor
from predictive_maintenance.core.scheduler import PmScheduler

setup_logging()


def split_comma_string(v: Union[str, List[str]]) -> List[str]:
    if isinstance(v, str):
        # Split on commas and/or whitespace, strip each VIN
        return [item.strip() for item in v.replace(",", " ").split() if item.strip()]
    return v


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Application starting",
                config=settings.model_dump(context={"redact": True}))  # Log config for debugging

    app.state.nats_client = NatsConnector()
    await app.state.nats_client.connect()

    app.state.data_api = DataApiConnector()
    await app.state.data_api.connect()
    await app.state.data_api.is_healthy()

    processor = Processor(app.state.data_api.get_client(), app.state.nats_client)

    scheduler = PmScheduler(processor)
    app.state.scheduler = scheduler
    scheduler.start()

    vins_to_schedule = split_comma_string(settings.scheduled_vins)
    for vin in vins_to_schedule:
        app.state.scheduler.schedule_analysis(vin, settings.poll_interval_seconds)

    yield

    scheduler.shutdown()
    await app.state.data_api.close()
    await app.state.nats_client.close()


# 2. Initialize the App
app = FastAPI(
    title="predictive-maintenance",
    version="1.0.0",
    lifespan=lifespan
)

# 3. Include Routers
app.include_router(api_router)

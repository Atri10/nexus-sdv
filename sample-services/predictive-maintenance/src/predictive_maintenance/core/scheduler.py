from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.memory import MemoryJobStore
from datetime import datetime

from predictive_maintenance.config.logging import logger
from predictive_maintenance.core.processor import Processor


class PmScheduler:

    def __init__(self, processor: Processor):
        self._processor: Processor = processor
        # Configuration for the In-Memory store
        jobstores = {
            'default': MemoryJobStore()
        }
        # Use AsyncIOScheduler to play nice with FastAPI's event loop
        self.scheduler = AsyncIOScheduler(jobstores=jobstores)

    def start(self):
        self.scheduler.start()
        logger.info("scheduler_started", job_store="memory")

    def shutdown(self):
        self.scheduler.shutdown()
        logger.info("scheduler_stopped", job_store="memory")

    def schedule_analysis(self, vehicle_id: str, interval_seconds: int):
        job = self.scheduler.add_job(
            self._execute_analysis,
            'interval',
            seconds=interval_seconds,
            args=[vehicle_id],
            id=f"recurring_{vehicle_id}",
            replace_existing=True,
            next_run_time=datetime.now()
        )
        logger.info(
            "analysis_job_scheduled",
            vehicle_id=vehicle_id,
            interval_seconds=interval_seconds,
            job_id=job.id,
        )
        return job.id

    def stop_analysis(self, vehicle_id: str):
        self.scheduler.remove_job(f"recurring_{vehicle_id}")
        logger.info("analysis_job_removed", vehicle_id=vehicle_id)

    def retrieve_jobs(self):
        jobs = self.scheduler.get_jobs(jobstore="default")

        job_list = [job.id for job in jobs]
        return job_list

    async def _execute_analysis(self, vehicle_id: str):
        logger.debug("analysis_job_started", vehicle_id=vehicle_id)
        await self._processor.run(vehicle_id)

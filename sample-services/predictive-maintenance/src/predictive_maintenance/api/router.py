from fastapi import APIRouter

from predictive_maintenance.api.endpoints import healthcheck

api_router = APIRouter()

api_router.include_router(healthcheck.router, prefix="/health", tags=["Health"])

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from predictive_maintenance.config.logging import logger

router = APIRouter()


@router.get(path="/liveness")
async def liveness(request: Request):
    return JSONResponse(status_code=200, content=None)


@router.get(path="")
async def health_check(request: Request):
    logger.debug("healthcheck_started")
    grpc_client = request.app.state.data_api
    nats_client = request.app.state.nats_client
    is_grpc_connected = await grpc_client.is_healthy()
    is_nats_connected = nats_client.is_connected

    data_api_status = "Up" if is_grpc_connected else "Down"
    nats_status = "Up" if is_nats_connected else "Down"
    app_status = "healthy" if is_grpc_connected else "unhealthy"
    response_status = 200 if is_grpc_connected else 503

    log_method = logger.debug if response_status == 200 else logger.warning
    log_method(
        "healthcheck_completed",
        status=app_status,
        grpc=data_api_status,
        nats=nats_status,
        response_status=response_status,
    )

    return JSONResponse(
        status_code=response_status,
        content={"status": app_status, "grpc": data_api_status, "nats": nats_status}
    )

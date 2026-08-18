import logging
import sys
from typing import Final

import structlog

from predictive_maintenance.config.config import settings


SERVICE_NAME: Final = "predictive-maintenance"
_LOG_LEVELS: Final = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}
_NOISY_DEPENDENCY_LOGGERS: Final = (
    "asyncio",
    "grpc",
    "grpclib",
    "hpack",
    "httpcore",
    "httpx",
)


def normalize_log_level(value: str) -> str:
    normalized = str(value).strip().lower()
    if normalized not in _LOG_LEVELS:
        supported = ", ".join(_LOG_LEVELS)
        raise ValueError(f"LOG_LEVEL must be one of: {supported}")
    return normalized


def setup_logging(level: str | None = None) -> str:
    """Configure JSON logging for the service and return the active level."""
    active_level = normalize_log_level(level or settings.log_level)
    level_number = _LOG_LEVELS[active_level]
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    formatter = structlog.stdlib.ProcessorFormatter(
        processor=structlog.processors.JSONRenderer(),
        foreign_pre_chain=processors,
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    for existing_handler in root_logger.handlers[:]:
        root_logger.removeHandler(existing_handler)
        existing_handler.close()
    root_logger.addHandler(handler)
    root_logger.setLevel(level_number)

    # Route framework and scheduler records through the same JSON formatter.
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access", "apscheduler"):
        framework_logger = logging.getLogger(logger_name)
        for existing_handler in framework_logger.handlers[:]:
            framework_logger.removeHandler(existing_handler)
            existing_handler.close()
        framework_logger.setLevel(level_number)
        framework_logger.propagate = True
    for logger_name in _NOISY_DEPENDENCY_LOGGERS:
        logging.getLogger(logger_name).setLevel(logging.WARNING)

    structlog.configure(
        processors=processors + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(level_number),
        cache_logger_on_first_use=True,
    )
    structlog.contextvars.bind_contextvars(service=SERVICE_NAME)
    return active_level


logger = structlog.get_logger(SERVICE_NAME)

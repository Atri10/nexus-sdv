import structlog

from predictive_maintenance.config.config import settings


def setup_logging():
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]

    if settings.log_level == "debug":
        # Dev: pretty, colorful logs for the terminal
        processors.append(structlog.dev.ConsoleRenderer())
    else:
        # Local/prod: JSON lines (parsable by compose logs)
        processors.append(structlog.processors.JSONRenderer())

    structlog.configure(
        processors=processors,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


logger = structlog.get_logger()

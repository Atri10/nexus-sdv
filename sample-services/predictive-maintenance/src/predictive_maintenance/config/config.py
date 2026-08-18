from typing import Any, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


LogLevel = Literal["debug", "info", "warning", "error", "critical"]
_LOG_LEVELS = frozenset({"debug", "info", "warning", "error", "critical"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", extra="ignore")
    nats_host: str = "nats"
    nats_port: int = 4222
    nats_user: str = "connector"
    nats_password: str = "connector-pass"
    data_api_grpc_addr: str = "data-api:8080"
    scheduled_vins: str = ""          # comma- and/or whitespace-separated; empty = none
    poll_interval_seconds: int = 60
    battery_window_days: int = 30
    log_level: LogLevel = "info"

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: Any) -> str:
        normalized = str(value).strip().lower()
        if normalized not in _LOG_LEVELS:
            supported = ", ".join(sorted(_LOG_LEVELS))
            raise ValueError(f"LOG_LEVEL must be one of: {supported}")
        return normalized

    def public_dict(self) -> dict[str, Any]:
        """Return startup configuration without credentials."""
        values = self.model_dump()
        values["nats_password"] = "[REDACTED]"
        return values


settings = Settings()

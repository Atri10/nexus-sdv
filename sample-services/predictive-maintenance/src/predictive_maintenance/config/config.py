from pydantic_settings import BaseSettings, SettingsConfigDict


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
    log_level: str = "info"


settings = Settings()

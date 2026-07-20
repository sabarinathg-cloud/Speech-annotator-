from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

LOCAL_DATABASE_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_name: str = "outcomes.ai speech annotator API"
    api_v1_prefix: str = "/api/v1"
    environment: str = Field(default="development", alias="ENVIRONMENT")
    debug: bool = Field(default=False, alias="DEBUG")

    database_url: str = Field(
        default="postgresql+psycopg://outcomes_user:outcomes_password@localhost:5432/outcomes_annotator",
        alias="DATABASE_URL",
    )
    jwt_secret_key: str = Field(default="dev-secret", alias="JWT_SECRET_KEY")
    jwt_refresh_secret_key: str = Field(default="dev-refresh-secret", alias="JWT_REFRESH_SECRET_KEY")
    token_expire_minutes: int = Field(default=30, alias="TOKEN_EXPIRE_MINUTES")
    refresh_token_expire_minutes: int = Field(default=10080, alias="REFRESH_TOKEN_EXPIRE_MINUTES")
    algorithm: str = "HS256"

    upload_dir: str = Field(default="data/uploads", alias="UPLOAD_DIR")
    audio_signing_secret: str = Field(default="dev-audio-secret", alias="AUDIO_SIGNING_SECRET")
    audio_signing_expire_seconds: int = 300

    s3_enabled: bool = False
    s3_endpoint_url: str | None = None
    s3_region: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None

    cors_origins: str = Field(default="http://localhost:3000", alias="CORS_ORIGINS")
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    jobs_inline: bool = Field(default=True, alias="JOBS_INLINE")
    login_rate_limit_enabled: bool = Field(default=True, alias="LOGIN_RATE_LIMIT_ENABLED")
    login_rate_limit_max_attempts: int = Field(default=5, alias="LOGIN_RATE_LIMIT_MAX_ATTEMPTS")
    login_rate_limit_window_seconds: int = Field(default=900, alias="LOGIN_RATE_LIMIT_WINDOW_SECONDS")
    abandoned_upload_cleanup_hours: int = Field(default=24, alias="ABANDONED_UPLOAD_CLEANUP_HOURS")
    failed_job_output_cleanup_hours: int = Field(default=24, alias="FAILED_JOB_OUTPUT_CLEANUP_HOURS")
    export_file_cleanup_hours: int = Field(default=168, alias="EXPORT_FILE_CLEANUP_HOURS")
    task_manifest_import_roots: str = Field(default="", alias="TASK_MANIFEST_IMPORT_ROOTS")
    pii_ml_detection_enabled: bool = Field(default=False, alias="PII_ML_DETECTION_ENABLED")
    pii_model_preload_enabled: bool = Field(default=False, alias="PII_MODEL_PRELOAD_ENABLED")
    hiring_audio_import_roots: str = Field(default="", alias="HIRING_AUDIO_IMPORT_ROOTS")
    hiring_audio_import_max_files: int = Field(default=5000, alias="HIRING_AUDIO_IMPORT_MAX_FILES")
    hiring_audio_import_min_free_bytes: int = Field(
        default=1_073_741_824,
        alias="HIRING_AUDIO_IMPORT_MIN_FREE_BYTES",
    )
    deepgram_api_key: str = Field(default="", alias="DEEPGRAM_API_KEY")
    deepgram_api_url: str = Field(default="https://api.deepgram.com/v1/listen", alias="DEEPGRAM_API_URL")
    deepgram_model: str = Field(default="nova-3", alias="DEEPGRAM_MODEL")
    deepgram_timeout_seconds: int = Field(default=120, alias="DEEPGRAM_TIMEOUT_SECONDS")
    hiring_deepgram_reference_max_files: int = Field(default=2500, alias="HIRING_DEEPGRAM_REFERENCE_MAX_FILES")

    @field_validator("database_url", mode="before")
    @classmethod
    def normalize_postgres_driver(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        return value

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        if self.environment.lower() in {"prod", "production"}:
            default_values = {
                self.jwt_secret_key: {"dev-secret", "replace-me-with-long-secret"},
                self.jwt_refresh_secret_key: {"dev-refresh-secret", "replace-me-with-long-refresh-secret"},
                self.audio_signing_secret: {"dev-audio-secret", "replace-me-audio-secret"},
            }
            insecure = [value for value, defaults in default_values.items() if value in defaults]
            if insecure:
                raise ValueError("Invalid production secrets: replace default JWT and audio signing secrets")
            if self.debug:
                raise ValueError("Invalid production config: DEBUG must be false")
            if "*" in self.cors_origin_list:
                raise ValueError("Invalid production config: wildcard CORS origins are not allowed")
            localhost_origins = [
                origin for origin in self.cors_origin_list if "localhost" in origin or "127.0.0.1" in origin
            ]
            if localhost_origins:
                raise ValueError("Invalid production config: local CORS origins are not allowed")

            database_host = urlparse(self.database_url).hostname
            if database_host in LOCAL_DATABASE_HOSTS:
                raise ValueError("Invalid production config: local database URLs are not allowed")
        return self

    @property
    def upload_path(self) -> Path:
        path = Path(self.upload_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def task_manifest_import_root_list(self) -> list[Path]:
        return [Path(value).expanduser() for value in self.task_manifest_import_roots.split(",") if value.strip()]

    @property
    def hiring_audio_import_root_list(self) -> list[Path]:
        return [Path(value).expanduser() for value in self.hiring_audio_import_roots.split(",") if value.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

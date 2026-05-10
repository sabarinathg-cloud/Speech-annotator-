from app.core.config import Settings


def test_database_url_normalizes_default_railway_postgres_scheme():
    settings = Settings(DATABASE_URL="postgresql://user:pass@postgres.railway.internal:5432/railway")

    assert settings.database_url == "postgresql+psycopg://user:pass@postgres.railway.internal:5432/railway"


def test_production_defaults_debug_to_false():
    settings = Settings(
        ENVIRONMENT="production",
        DATABASE_URL="postgresql://user:pass@postgres.railway.internal:5432/railway",
        JWT_SECRET_KEY="production-access-secret",
        JWT_REFRESH_SECRET_KEY="production-refresh-secret",
        AUDIO_SIGNING_SECRET="production-audio-secret",
        CORS_ORIGINS="https://speech-annotator.example.com",
    )

    assert settings.debug is False


def test_production_rejects_wildcard_cors_with_credentials():
    try:
        Settings(
            ENVIRONMENT="production",
            DATABASE_URL="postgresql://user:pass@postgres.railway.internal:5432/railway",
            JWT_SECRET_KEY="production-access-secret",
            JWT_REFRESH_SECRET_KEY="production-refresh-secret",
            AUDIO_SIGNING_SECRET="production-audio-secret",
            CORS_ORIGINS="*",
        )
    except ValueError as exc:
        assert "wildcard CORS" in str(exc)
    else:
        raise AssertionError("production settings accepted wildcard CORS origins")


def test_production_rejects_local_database_url():
    try:
        Settings(
            ENVIRONMENT="production",
            DATABASE_URL="postgresql://user:pass@localhost:5432/outcomes_annotator",
            JWT_SECRET_KEY="production-access-secret",
            JWT_REFRESH_SECRET_KEY="production-refresh-secret",
            AUDIO_SIGNING_SECRET="production-audio-secret",
            CORS_ORIGINS="https://speech-annotator.example.com",
        )
    except ValueError as exc:
        assert "local database" in str(exc)
    else:
        raise AssertionError("production settings accepted a local database URL")

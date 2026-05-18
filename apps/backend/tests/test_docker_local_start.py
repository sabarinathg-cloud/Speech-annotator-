from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]


def test_default_compose_does_not_require_a_local_env_file():
    compose_text = (REPO_ROOT / "docker-compose.yml").read_text()

    assert "env_file:" not in compose_text


def test_backend_startup_can_seed_local_demo_users():
    start_script = (REPO_ROOT / "apps/backend/scripts/start.sh").read_text()

    assert "AUTO_SEED_DEV_USERS" in start_script
    assert "scripts/seed.py" in start_script


def test_default_compose_exposes_single_local_app_entrypoint():
    compose_text = (REPO_ROOT / "docker-compose.yml").read_text()

    assert '"5432:5432"' not in compose_text
    assert '"6379:6379"' not in compose_text
    assert '"8000:8000"' not in compose_text
    assert '"3000:3000"' not in compose_text
    assert '"8080:80"' in compose_text
    assert "http://localhost:8080/api/v1" in compose_text


def test_default_compose_does_not_preload_heavy_pii_models():
    compose_text = (REPO_ROOT / "docker-compose.yml").read_text()

    assert "PII_MODEL_PRELOAD_ENABLED: ${PII_MODEL_PRELOAD_ENABLED:-false}" in compose_text

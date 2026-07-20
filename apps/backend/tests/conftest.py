from collections.abc import Generator
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.dependencies import get_db_session
from app.core.security import get_password_hash
from app.main import app
from app.models.base import Base
from app.models.enums import RoleEnum
from app.models.organization import OrganizationMembership
from app.models.user import User
from app.services.organization_service import OrganizationService


@pytest.fixture(scope="session")
def db_engine(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("db") / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def db_session(db_engine) -> Generator[Session, None, None]:
    connection = db_engine.connect()
    transaction = connection.begin()
    session_local = sessionmaker(bind=connection, autocommit=False, autoflush=False)
    session = session_local()
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture(scope="function")
def client(db_session: Session, tmp_path: Path) -> Generator[TestClient, None, None]:
    settings = get_settings()
    original_upload_dir = settings.upload_dir
    original_jobs_inline = settings.jobs_inline
    original_pii_preload_enabled = settings.pii_model_preload_enabled
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir = str(upload_dir)
    settings.jobs_inline = True
    settings.pii_model_preload_enabled = False

    def override_db():
        yield db_session

    app.dependency_overrides[get_db_session] = override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    settings.upload_dir = original_upload_dir
    settings.jobs_inline = original_jobs_inline
    settings.pii_model_preload_enabled = original_pii_preload_enabled


@pytest.fixture(scope="function")
def seed_users(db_session: Session) -> dict[str, User]:
    admin = User(
        email="admin@test.com",
        full_name="Admin",
        password_hash=get_password_hash("Admin@123"),
        role=RoleEnum.ADMIN,
        is_active=True,
        confidentiality_acknowledged_at=datetime.now(timezone.utc),
        confidentiality_acknowledged_version="2026-05-sensitive-data-v1",
    )
    annotator = User(
        email="annotator@test.com",
        full_name="Annotator",
        password_hash=get_password_hash("Annotator@123"),
        role=RoleEnum.ANNOTATOR,
        is_active=True,
        confidentiality_acknowledged_at=datetime.now(timezone.utc),
        confidentiality_acknowledged_version="2026-05-sensitive-data-v1",
    )
    reviewer = User(
        email="reviewer@test.com",
        full_name="Reviewer",
        password_hash=get_password_hash("Reviewer@123"),
        role=RoleEnum.REVIEWER,
        is_active=True,
        confidentiality_acknowledged_at=datetime.now(timezone.utc),
        confidentiality_acknowledged_version="2026-05-sensitive-data-v1",
    )
    candidate = User(
        email="candidate@test.com",
        full_name="Candidate",
        password_hash=get_password_hash("Candidate@123"),
        role=RoleEnum.CANDIDATE,
        is_active=True,
        confidentiality_acknowledged_at=datetime.now(timezone.utc),
        confidentiality_acknowledged_version="2026-05-sensitive-data-v1",
    )
    db_session.add_all([admin, annotator, reviewer, candidate])
    db_session.flush()
    organization = OrganizationService(db_session).ensure_default_organization()
    db_session.add_all(
        [
            OrganizationMembership(user_id=user.id, organization_id=organization.id, is_active=True)
            for user in [annotator, reviewer, candidate]
        ]
    )
    db_session.commit()
    return {"admin": admin, "annotator": annotator, "reviewer": reviewer, "candidate": candidate}


def _login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    acknowledgement = client.post(
        "/api/v1/auth/confidentiality-acknowledgement",
        headers={"Authorization": f"Bearer {response.json()['access_token']}"},
    )
    assert acknowledgement.status_code == 200
    return acknowledgement.json()["access_token"]


@pytest.fixture(scope="function")
def auth_headers(client: TestClient, seed_users):
    admin_token = _login(client, "admin@test.com", "Admin@123")
    annotator_token = _login(client, "annotator@test.com", "Annotator@123")
    reviewer_token = _login(client, "reviewer@test.com", "Reviewer@123")
    candidate_token = _login(client, "candidate@test.com", "Candidate@123")
    return {
        "admin": {"Authorization": f"Bearer {admin_token}"},
        "annotator": {"Authorization": f"Bearer {annotator_token}"},
        "reviewer": {"Authorization": f"Bearer {reviewer_token}"},
        "candidate": {"Authorization": f"Bearer {candidate_token}"},
    }


@pytest.fixture(scope="function")
def sample_excel_bytes(tmp_path: Path) -> bytes:
    audio_one = tmp_path / "audio1.mp3"
    audio_two = tmp_path / "audio2.mp3"
    audio_one.write_bytes(b"ID3")
    audio_two.write_bytes(b"ID3")

    dataframe = pd.DataFrame(
        [
            {
                "id": "ROW-001",
                "file_location": f"local://{audio_one}",
                "model_1_transcript": "hello from model one",
                "model_2_transcript": "hello from model two",
                "speaker_gender": "female",
                "language": "en",
                "notes": "check punctuation",
                "custom_tag": "A1",
            },
            {
                "id": "",
                "file_location": f"local://{audio_two}",
                "model_1_transcript": "",
                "model_2_transcript": "",
                "speaker_gender": "male",
                "language": "hi",
                "notes": "missing fields",
                "custom_tag": "A2",
            },
        ]
    )
    output = BytesIO()
    dataframe.to_excel(output, index=False)
    return output.getvalue()

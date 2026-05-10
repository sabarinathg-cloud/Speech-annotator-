from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.core.database import SessionLocal
from app.core.security import get_password_hash
from app.models.enums import RoleEnum
from app.models.task import AnnotationTask, TaskStatusHistory, TaskTranscriptVariant
from app.models.upload import UploadFile, UploadJob
from app.models.user import User
from app.services.security_audit_service import CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION

LEGACY_DEMO_TASK_EXTERNAL_IDS = ("OUT-0001", "OUT-0002")
LEGACY_DEMO_UPLOAD_FILENAME = "sample_tasks.xlsx"


def upsert_user(session, email: str, full_name: str, password: str, role: RoleEnum) -> User:
    existing = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if existing:
        if not existing.confidentiality_acknowledged_at:
            existing.confidentiality_acknowledged_at = datetime.now(UTC)
            existing.confidentiality_acknowledged_version = CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION
        return existing
    user = User(
        email=email,
        full_name=full_name,
        password_hash=get_password_hash(password),
        role=role,
        is_active=True,
        confidentiality_acknowledged_at=datetime.now(UTC),
        confidentiality_acknowledged_version=CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION,
    )
    session.add(user)
    session.flush()
    return user


def remove_legacy_demo_tasks(session) -> None:
    demo_upload_file_ids = session.execute(
        select(UploadFile.id).where(UploadFile.original_filename == LEGACY_DEMO_UPLOAD_FILENAME)
    ).scalars().all()
    demo_task_ids = session.execute(
        select(AnnotationTask.id).where(AnnotationTask.external_id.in_(LEGACY_DEMO_TASK_EXTERNAL_IDS))
    ).scalars().all()
    if demo_task_ids:
        session.execute(delete(TaskTranscriptVariant).where(TaskTranscriptVariant.task_id.in_(demo_task_ids)))
        session.execute(delete(TaskStatusHistory).where(TaskStatusHistory.task_id.in_(demo_task_ids)))
    session.execute(delete(AnnotationTask).where(AnnotationTask.external_id.in_(LEGACY_DEMO_TASK_EXTERNAL_IDS)))
    if demo_upload_file_ids:
        session.execute(delete(UploadJob).where(UploadJob.upload_file_id.in_(demo_upload_file_ids)))
        session.execute(delete(UploadFile).where(UploadFile.id.in_(demo_upload_file_ids)))


def seed() -> None:
    session = SessionLocal()
    try:
        upsert_user(session, "admin@outcomes.ai", "outcomes.ai Admin", "Admin@123", RoleEnum.ADMIN)
        upsert_user(
            session,
            "annotator@outcomes.ai",
            "outcomes.ai Annotator",
            "Annotator@123",
            RoleEnum.ANNOTATOR,
        )
        upsert_user(
            session,
            "reviewer@outcomes.ai",
            "outcomes.ai Reviewer",
            "Reviewer@123",
            RoleEnum.REVIEWER,
        )
        remove_legacy_demo_tasks(session)
        session.commit()
        print("Development users ensured. No task data was seeded.")
    finally:
        session.close()


if __name__ == "__main__":
    seed()

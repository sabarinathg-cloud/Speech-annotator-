from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import or_, select

from app.core.config import get_settings
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.job import BackgroundJob
from app.models.upload import UploadFile, UploadJob


def _unlink_if_present(path_value: str | None) -> bool:
    if not path_value:
        return False
    path = Path(path_value)
    if not path.exists() or not path.is_file():
        return False
    path.unlink()
    return True


def run_cleanup(session: Session | None = None) -> dict[str, int]:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    abandoned_upload_cutoff = now - timedelta(hours=settings.abandoned_upload_cleanup_hours)
    failed_job_cutoff = now - timedelta(hours=settings.failed_job_output_cleanup_hours)
    export_cutoff = now - timedelta(hours=settings.export_file_cleanup_hours)
    counts = {
        "abandoned_upload_files_deleted": 0,
        "job_output_files_deleted": 0,
    }

    owns_session = session is None
    if session is None:
        session = SessionLocal()
    try:
        abandoned_uploads = session.execute(
            select(UploadFile)
            .join(UploadJob, UploadJob.upload_file_id == UploadFile.id)
            .where(UploadJob.imported_at.is_(None))
            .where(UploadJob.created_at < abandoned_upload_cutoff)
        ).scalars()
        seen_upload_paths: set[str] = set()
        for upload in abandoned_uploads:
            if upload.stored_path in seen_upload_paths:
                continue
            seen_upload_paths.add(upload.stored_path)
            if _unlink_if_present(upload.stored_path):
                counts["abandoned_upload_files_deleted"] += 1

        expired_jobs = session.execute(
            select(BackgroundJob)
            .where(BackgroundJob.output_path.is_not(None))
            .where(
                or_(
                    (BackgroundJob.status == "FAILED") & (BackgroundJob.completed_at < failed_job_cutoff),
                    (BackgroundJob.job_type == "export") & (BackgroundJob.completed_at < export_cutoff),
                )
            )
        ).scalars()
        for job in expired_jobs:
            if _unlink_if_present(job.output_path):
                counts["job_output_files_deleted"] += 1
            job.output_path = None
        if owns_session:
            session.commit()
        else:
            session.flush()
        return counts
    finally:
        if owns_session:
            session.close()


if __name__ == "__main__":
    print(run_cleanup())

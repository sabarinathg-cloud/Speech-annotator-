from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from app.models.enums import UploadJobStatusEnum
from app.models.upload import UploadFile, UploadJob, UploadJobError


class UploadRepository:
    def __init__(self, db: Session):
        self.db = db

    def create_upload_file(
        self,
        *,
        original_filename: str,
        stored_path: str,
        content_type: str | None,
        uploaded_by_id: str,
    ) -> UploadFile:
        upload_file = UploadFile(
            original_filename=original_filename,
            stored_path=stored_path,
            content_type=content_type,
            uploaded_by_id=uploaded_by_id,
        )
        self.db.add(upload_file)
        self.db.flush()
        return upload_file

    def create_upload_job(self, *, upload_file_id: str, created_by_id: str) -> UploadJob:
        job = UploadJob(upload_file_id=upload_file_id, created_by_id=created_by_id)
        self.db.add(job)
        self.db.flush()
        return job

    def get_upload_job(self, upload_job_id: str) -> UploadJob | None:
        stmt = (
            select(UploadJob)
            .options(joinedload(UploadJob.upload_file))
            .where(UploadJob.id == upload_job_id)
        )
        return self.db.execute(stmt).scalar_one_or_none()

    def update_upload_job(
        self,
        job: UploadJob,
        *,
        status: UploadJobStatusEnum | None = None,
        mapping_json: dict | None = None,
        preview_row_count: int | None = None,
        validated: bool = False,
        imported: bool = False,
    ) -> UploadJob:
        if status:
            job.status = status
        if mapping_json is not None:
            job.mapping_json = mapping_json
        if preview_row_count is not None:
            job.preview_row_count = preview_row_count
        if validated:
            job.validated_at = datetime.now(timezone.utc)
        if imported:
            job.imported_at = datetime.now(timezone.utc)
        self.db.flush()
        return job

    def clear_job_errors(self, upload_job_id: str) -> None:
        self.db.execute(delete(UploadJobError).where(UploadJobError.upload_job_id == upload_job_id))
        self.db.flush()

    def add_job_errors(self, upload_job_id: str, errors: list[dict]) -> None:
        for error in errors:
            self.db.add(
                UploadJobError(
                    upload_job_id=upload_job_id,
                    row_number=error["row_number"],
                    field_name=error.get("field_name"),
                    error_message=error["error_message"],
                    raw_value=error.get("raw_value"),
                )
            )
        self.db.flush()

    def list_job_errors(self, upload_job_id: str) -> list[UploadJobError]:
        stmt = (
            select(UploadJobError)
            .where(UploadJobError.upload_job_id == upload_job_id)
            .order_by(UploadJobError.row_number.asc(), UploadJobError.created_at.asc())
        )
        return list(self.db.execute(stmt).scalars().all())

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.job import BackgroundJob
from app.models.organization import Organization
from app.models.user import User
from app.schemas.hiring import HiringDeepgramReferenceRequest
from app.schemas.job import ExportJobRequest
from app.schemas.upload import ColumnMappingRequest
from app.services.errors import ServiceError
from app.services.export_service import ExportService
from app.services.hiring_service import HiringService
from app.services.organization_service import DEFAULT_ORGANIZATION_ID
from app.services.upload_service import UploadService


class JobService:
    def __init__(self, db: Session):
        self.db = db

    def enqueue_export_job(self, payload: ExportJobRequest, actor: User, organization: Organization) -> BackgroundJob:
        job = self._create_job(
            job_type="export",
            payload=payload.model_dump(mode="json"),
            actor=actor,
            organization_id=organization.id,
        )
        self._dispatch(job)
        self.db.refresh(job)
        return job

    def enqueue_import_job(
        self,
        *,
        upload_job_id: str,
        mapping: ColumnMappingRequest | None,
        actor: User,
        organization: Organization,
    ) -> BackgroundJob:
        job = self._create_job(
            job_type="import",
            payload={
                "upload_job_id": upload_job_id,
                "mapping": mapping.model_dump(mode="json") if mapping else None,
            },
            actor=actor,
            organization_id=organization.id,
        )
        self._dispatch(job)
        self.db.refresh(job)
        return job

    def enqueue_hiring_deepgram_reference_job(
        self,
        *,
        assessment_id: str,
        payload: HiringDeepgramReferenceRequest,
        actor: User,
        organization: Organization,
        dispatch: bool = True,
    ) -> BackgroundJob:
        job = self._create_job(
            job_type="hiring_deepgram_references",
            payload={
                "assessment_id": assessment_id,
                "overwrite_existing": payload.overwrite_existing,
            },
            actor=actor,
            organization_id=organization.id,
        )
        if dispatch:
            self._dispatch(job)
            self.db.refresh(job)
        return job

    def get_job(self, job_id: str, *, organization_id: str | None = None) -> BackgroundJob:
        job = self.db.get(BackgroundJob, job_id)
        if not job:
            raise ServiceError("Background job not found", status_code=404)
        if organization_id and job.organization_id not in {organization_id, None}:
            raise ServiceError("Background job not found", status_code=404)
        if organization_id != DEFAULT_ORGANIZATION_ID and job.organization_id is None:
            raise ServiceError("Background job not found", status_code=404)
        return job

    def download_job_output(self, job_id: str, *, organization_id: str | None = None) -> tuple[bytes, str, str]:
        job = self.get_job(job_id, organization_id=organization_id)
        if job.status != "COMPLETED":
            raise ServiceError("Background job is not complete", status_code=409)
        if not job.output_path:
            raise ServiceError("Background job does not have a downloadable output", status_code=404)

        output_path = Path(job.output_path)
        if not output_path.exists():
            raise ServiceError("Background job output is no longer available", status_code=404)
        return output_path.read_bytes(), job.content_type or "application/octet-stream", output_path.name

    def run_job(self, job_id: str) -> None:
        job = self.get_job(job_id)
        if job.status not in {"QUEUED", "FAILED"}:
            return

        job.status = "RUNNING"
        job.started_at = datetime.now(timezone.utc)
        job.error_message = None
        self.db.commit()

        try:
            result = self._execute_job(job_id)
            job = self.get_job(job_id)
            job.status = "COMPLETED"
            job.result = result
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
        except Exception as exc:
            self.db.rollback()
            job = self.get_job(job_id)
            job.status = "FAILED"
            job.error_message = str(exc)
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()

    def _create_job(
        self, *, job_type: str, payload: dict[str, Any], actor: User, organization_id: str | None
    ) -> BackgroundJob:
        job = BackgroundJob(
            organization_id=organization_id,
            job_type=job_type,
            status="QUEUED",
            payload=payload,
            created_by_id=actor.id,
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def _dispatch(self, job: BackgroundJob) -> None:
        settings = get_settings()
        if settings.jobs_inline:
            self.run_job(job.id)
            return

        try:
            from redis import Redis
            from rq import Queue
        except ImportError as exc:
            raise ServiceError("Background queue dependencies are not installed", status_code=503) from exc

        redis_conn = Redis.from_url(settings.redis_url)
        queue = Queue("speech-annotator", connection=redis_conn)
        queue.enqueue("app.services.job_service.run_queued_job", job.id)

    def _execute_job(self, job_id: str) -> dict[str, Any]:
        job = self.get_job(job_id)
        if job.job_type == "export":
            return self._execute_export(job)
        if job.job_type == "import":
            return self._execute_import(job)
        if job.job_type == "hiring_deepgram_references":
            return self._execute_hiring_deepgram_references(job)
        raise ServiceError(f"Unsupported background job type: {job.job_type}", status_code=422)

    def _execute_export(self, job: BackgroundJob) -> dict[str, Any]:
        payload = ExportJobRequest.model_validate(job.payload)
        export_format = payload.format
        if not job.organization_id:
            raise ServiceError("Export job is missing organization_id", status_code=422)
        from app.services.organization_service import OrganizationService

        organization = OrganizationService(self.db).get_organization_or_404(job.organization_id)
        content, content_type = ExportService(self.db).export_tasks(
            job_id=payload.job_id,
            export_format=export_format,
            status=payload.status,
            assignee_id=payload.assignee_id,
            language=payload.language,
            date_from=payload.date_from,
            date_to=payload.date_to,
            organization_id=job.organization_id,
            transcript_redaction_enabled=organization.transcript_redaction_enabled,
        )

        output_dir = get_settings().upload_path / "exports"
        output_dir.mkdir(parents=True, exist_ok=True)
        filename = f"annotations_export_{job.id}.{export_format}"
        output_path = output_dir / filename
        output_path.write_bytes(content)

        job.output_path = str(output_path)
        job.content_type = content_type
        self.db.flush()
        return {
            "filename": filename,
            "format": export_format,
            "content_type": content_type,
            "bytes": len(content),
        }

    def _execute_import(self, job: BackgroundJob) -> dict[str, Any]:
        upload_job_id = job.payload.get("upload_job_id")
        if not upload_job_id:
            raise ServiceError("Import job is missing upload_job_id", status_code=422)

        raw_mapping = job.payload.get("mapping")
        mapping = ColumnMappingRequest.model_validate(raw_mapping) if raw_mapping else None
        organization = job.organization_id
        if not organization:
            raise ServiceError("Import job is missing organization_id", status_code=422)
        from app.services.organization_service import OrganizationService

        result = UploadService(self.db).import_upload(
            upload_job_id,
            mapping,
            organization=OrganizationService(self.db).get_organization_or_404(organization),
        )
        return result.model_dump(mode="json")

    def _execute_hiring_deepgram_references(self, job: BackgroundJob) -> dict[str, Any]:
        assessment_id = str(job.payload.get("assessment_id") or "")
        if not assessment_id:
            raise ServiceError("Deepgram reference job is missing assessment_id", status_code=422)
        if not job.organization_id:
            raise ServiceError("Deepgram reference job is missing organization_id", status_code=422)
        actor = self.db.get(User, job.created_by_id)
        result = HiringService(self.db).generate_deepgram_reference_transcripts(
            assessment_id=assessment_id,
            overwrite_existing=bool(job.payload.get("overwrite_existing")),
            actor=actor,
            organization_id=job.organization_id,
        )
        return result.model_dump(mode="json")


def run_queued_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        JobService(db).run_job(job_id)
    finally:
        db.close()


def run_queued_job_with_bind(job_id: str, bind: Any) -> None:
    session_local = sessionmaker(autocommit=False, autoflush=False, bind=bind, class_=Session)
    db = session_local()
    try:
        JobService(db).run_job(job_id)
    finally:
        db.close()

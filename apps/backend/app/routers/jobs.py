from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session, require_roles
from app.models.enums import RoleEnum
from app.models.job import BackgroundJob
from app.models.user import User
from app.schemas.job import JobStatusResponse
from app.services.errors import ServiceError
from app.services.job_service import JobService
from app.services.security_audit_service import SecurityAuditService

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


def _to_response(job: BackgroundJob) -> JobStatusResponse:
    return JobStatusResponse(
        id=job.id,
        job_id=job.id,
        job_type=job.job_type,
        status=job.status,
        payload=job.payload or {},
        result=job.result,
        error_message=job.error_message,
        output_available=bool(job.output_path and job.status == "COMPLETED"),
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


@router.get("/{job_id}", response_model=JobStatusResponse)
def get_job(
    job_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = JobService(db)
    try:
        return _to_response(service.get_job(job_id))
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{job_id}/download")
def download_job(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = JobService(db)
    try:
        content, content_type, filename = service.download_job_output(job_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc
    SecurityAuditService(db).log_event(
        action="DOWNLOAD_JOB_OUTPUT",
        actor=current_user,
        resource_type="job",
        resource_id=job_id,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        metadata={"filename": filename, "content_type": content_type},
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    )

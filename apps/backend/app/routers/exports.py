from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_roles
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.job import ExportJobRequest, JobCreateResponse
from app.services.export_service import ExportService
from app.services.errors import ServiceError
from app.services.job_service import JobService
from app.services.security_audit_service import SecurityAuditService

router = APIRouter(prefix="/exports", tags=["exports"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("/tasks")
def export_tasks(
    request: Request,
    job_id: str | None = Query(default=None),
    format: str = Query(default="csv", pattern="^(csv|xlsx)$"),
    status: TaskStatusEnum | None = Query(default=None),
    assignee_id: str | None = Query(default=None),
    language: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    task_ids: list[str] | None = Query(default=None),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = ExportService(db)
    try:
        payload, content_type = service.export_tasks(
            job_id=job_id,
            export_format=format,  # type: ignore[arg-type]
            status=status,
            assignee_id=assignee_id,
            language=language,
            date_from=date_from,
            date_to=date_to,
            task_ids=task_ids,
            organization_id=organization.id,
            transcript_redaction_enabled=organization.transcript_redaction_enabled,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc

    filename = f"outcomes_ai_annotations_export.{format}"
    SecurityAuditService(db).log_event(
        action="EXPORT_TASKS",
        actor=current_user,
        resource_type="export",
        resource_id=job_id,
        organization_id=organization.id,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        metadata={
            "format": format,
            "status": status.value if status else None,
            "assignee_id": assignee_id,
            "language": language,
            "date_from": date_from,
            "date_to": date_to,
            "selected_task_count": len(task_ids or []),
        },
    )
    return Response(
        content=payload,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/tasks/jobs", response_model=JobCreateResponse)
def enqueue_export_job(
    payload: ExportJobRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = JobService(db)
    try:
        job = service.enqueue_export_job(payload, current_user, organization)
        SecurityAuditService(db).log_event(
            action="ENQUEUE_EXPORT_JOB",
            actor=current_user,
            resource_type="export_job",
            resource_id=job.id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata=payload.model_dump(mode="json"),
        )
        return JobCreateResponse(job_id=job.id, status=job.status)
    except ServiceError as exc:
        raise _http_error(exc) from exc

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.metrics import ActivityHeartbeatRequest, ActivityHeartbeatResponse, AdminMetricsResponse
from app.services.errors import ServiceError
from app.services.metrics_service import MetricsService

router = APIRouter(prefix="/metrics", tags=["metrics"])


def _http_error(exc: ServiceError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


@router.post("/activity", response_model=ActivityHeartbeatResponse)
def record_activity_heartbeat(
    payload: ActivityHeartbeatRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = MetricsService(db)
    try:
        return service.record_activity_heartbeat(
            payload=payload,
            actor=current_user,
            organization_id=organization.id,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/admin", response_model=AdminMetricsResponse)
def get_admin_metrics(
    status: TaskStatusEnum | None = Query(default=None),
    assignee_id: str | None = Query(default=None),
    job_id: str | None = Query(default=None),
    language: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = MetricsService(db)
    return service.get_admin_metrics(
        status=status,
        assignee_id=assignee_id,
        upload_job_id=job_id,
        language=language,
        date_from=date_from,
        date_to=date_to,
        organization_id=organization.id,
    )

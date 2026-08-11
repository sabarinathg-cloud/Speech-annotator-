import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.metrics import (
    ActivityHeartbeatRequest,
    ActivityHeartbeatResponse,
    AdminMetricsResponse,
    PeopleActivityResponse,
)
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


@router.get("/people-activity", response_model=PeopleActivityResponse)
def get_people_activity(
    user_id: list[str] | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return MetricsService(db).get_people_activity(
            user_ids=user_id,
            date_from=date_from,
            date_to=date_to,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/people-activity/export")
def export_people_activity(
    user_id: list[str] | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        report = MetricsService(db).get_people_activity(
            user_ids=user_id,
            date_from=date_from,
            date_to=date_to,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc

    output = io.StringIO()
    fieldnames = [
        "date_from",
        "date_to",
        "user_id",
        "user_name",
        "user_email",
        "role",
        "scope",
        "organization_id",
        "organization_name",
        "active_seconds",
        "task_active_seconds",
        "idle_seconds",
        "total_tracked_seconds",
        "completed_segments",
        "average_active_seconds_per_segment",
        "efficiency_segments_per_active_hour",
        "focus_rate",
        "last_activity_at",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for item in report.items:
        writer.writerow(
            _people_activity_csv_row(
                report=report,
                item=item,
                summary=item.overall,
                scope="overall",
                organization_id="",
                organization_name="All organizations",
            )
        )
        for organization in item.organizations:
            writer.writerow(
                _people_activity_csv_row(
                    report=report,
                    item=item,
                    summary=organization,
                    scope="organization",
                    organization_id=organization.organization_id,
                    organization_name=organization.organization_name,
                )
            )

    filename = f"people_activity_{report.date_from.isoformat()}_to_{report.date_to.isoformat()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _people_activity_csv_row(*, report, item, summary, scope, organization_id, organization_name):
    return {
        "date_from": report.date_from.isoformat(),
        "date_to": report.date_to.isoformat(),
        "user_id": item.user_id,
        "user_name": item.user_name,
        "user_email": item.user_email,
        "role": item.role,
        "scope": scope,
        "organization_id": organization_id,
        "organization_name": organization_name,
        "active_seconds": summary.active_seconds,
        "task_active_seconds": summary.task_active_seconds,
        "idle_seconds": summary.idle_seconds,
        "total_tracked_seconds": summary.total_tracked_seconds,
        "completed_segments": summary.completed_segments,
        "average_active_seconds_per_segment": summary.average_active_seconds_per_segment,
        "efficiency_segments_per_active_hour": summary.efficiency_segments_per_active_hour,
        "focus_rate": summary.focus_rate,
        "last_activity_at": summary.last_activity_at.isoformat() if summary.last_activity_at else "",
    }

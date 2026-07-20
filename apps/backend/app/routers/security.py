from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_current_user, get_db_session, require_roles
from app.models.enums import RoleEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.security import ClientSecurityEventRequest, SecurityAuditEventListResponse, SecurityAuditEventResponse
from app.services.security_audit_service import SecurityAuditService

router = APIRouter(prefix="/security", tags=["security"])


@router.get("/audit-events", response_model=SecurityAuditEventListResponse)
def list_security_audit_events(
    action: str | None = Query(default=None, min_length=1, max_length=100),
    risk_level: str | None = Query(default=None, pattern="^(low|medium|high)$"),
    actor_user_id: str | None = Query(default=None),
    task_id: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    return SecurityAuditService(db).list_events(
        action=action,
        risk_level=risk_level,
        actor_user_id=actor_user_id,
        task_id=task_id,
        organization_id=organization.id,
        page=page,
        page_size=page_size,
    )


@router.post("/client-events", response_model=SecurityAuditEventResponse)
def log_client_security_event(
    payload: ClientSecurityEventRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
    organization: Organization = Depends(get_current_organization),
):
    event = SecurityAuditService(db).log_event(
        action=payload.action,
        actor=current_user,
        resource_type="client_security",
        resource_id=current_user.id,
        organization_id=organization.id,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        metadata=payload.metadata,
    )
    return SecurityAuditService(db)._to_response(event)

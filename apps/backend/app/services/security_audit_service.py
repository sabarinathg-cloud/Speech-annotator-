from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models.security import SecurityAuditEvent
from app.models.user import User
from app.schemas.security import SecurityAuditEventListResponse, SecurityAuditEventResponse

CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION = "2026-05-sensitive-data-v1"

RISK_BY_ACTION: dict[str, str] = {
    "ACKNOWLEDGE_CONFIDENTIALITY": "medium",
    "ATTEMPT_CONTEXT_MENU": "medium",
    "ATTEMPT_COPY": "high",
    "ATTEMPT_DEVTOOLS": "high",
    "ATTEMPT_PRINT": "high",
    "ATTEMPT_SCREEN_CAPTURE": "high",
    "ATTEMPT_SAVE_PAGE": "high",
    "ATTEMPT_VIEW_SOURCE": "high",
    "VIEW_TASK": "medium",
    "GENERATE_AUDIO_URL": "high",
    "STREAM_AUDIO": "high",
    "MASK_PII_AUDIO": "high",
    "EXPORT_TASKS": "high",
    "ENQUEUE_EXPORT_JOB": "high",
    "DOWNLOAD_JOB_OUTPUT": "high",
    "PASSWORD_CHANGED": "medium",
}

SENSITIVE_METADATA_KEYS = {
    "final_transcript",
    "notes",
    "pii_annotations",
    "original_row",
    "custom_metadata",
    "file_location",
    "masked_audio_location",
    "masked_intervals",
}


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def sanitize_security_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not metadata:
        return {}
    sanitized: dict[str, Any] = {}
    for key, value in metadata.items():
        if key in SENSITIVE_METADATA_KEYS:
            sanitized[key] = "[REDACTED]"
        else:
            sanitized[key] = json_safe(value)
    return sanitized


class SecurityAuditService:
    def __init__(self, db: Session):
        self.db = db

    def log_event(
        self,
        *,
        action: str,
        actor: User | None,
        resource_type: str,
        resource_id: str | None = None,
        task_id: str | None = None,
        organization_id: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
        metadata: dict[str, Any] | None = None,
        risk_level: str | None = None,
        commit: bool = True,
    ) -> SecurityAuditEvent:
        event = SecurityAuditEvent(
            organization_id=organization_id,
            actor_user_id=actor.id if actor else None,
            actor_email=actor.email if actor else None,
            actor_role=actor.role.value if actor else None,
            action=action,
            risk_level=risk_level or RISK_BY_ACTION.get(action, "low"),
            resource_type=resource_type,
            resource_id=resource_id,
            task_id=task_id,
            ip_address=ip_address,
            user_agent=(user_agent or "")[:500] or None,
            event_metadata=sanitize_security_metadata(metadata),
        )
        self.db.add(event)
        self.db.flush()
        if commit:
            self.db.commit()
            self.db.refresh(event)
        return event

    def list_events(
        self,
        *,
        action: str | None,
        risk_level: str | None,
        actor_user_id: str | None,
        task_id: str | None,
        organization_id: str | None,
        page: int,
        page_size: int,
    ) -> SecurityAuditEventListResponse:
        stmt = select(SecurityAuditEvent)
        count_stmt = select(func.count(SecurityAuditEvent.id))
        filters = []
        if action:
            filters.append(SecurityAuditEvent.action == action)
        if risk_level:
            filters.append(SecurityAuditEvent.risk_level == risk_level)
        if actor_user_id:
            filters.append(SecurityAuditEvent.actor_user_id == actor_user_id)
        if task_id:
            filters.append(SecurityAuditEvent.task_id == task_id)
        if organization_id:
            filters.append(SecurityAuditEvent.organization_id == organization_id)
        if filters:
            stmt = stmt.where(and_(*filters))
            count_stmt = count_stmt.where(and_(*filters))
        stmt = (
            stmt.order_by(SecurityAuditEvent.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        items = list(self.db.execute(stmt).scalars().all())
        total = self.db.execute(count_stmt).scalar_one()
        return SecurityAuditEventListResponse(
            items=[self._to_response(event) for event in items],
            page=page,
            page_size=page_size,
            total=int(total),
        )

    def _to_response(self, event: SecurityAuditEvent) -> SecurityAuditEventResponse:
        return SecurityAuditEventResponse(
            id=event.id,
            organization_id=event.organization_id,
            actor_user_id=event.actor_user_id,
            actor_email=event.actor_email,
            actor_role=event.actor_role,
            action=event.action,
            risk_level=event.risk_level,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            task_id=event.task_id,
            ip_address=event.ip_address,
            user_agent=event.user_agent,
            metadata=event.event_metadata or {},
            created_at=event.created_at,
        )

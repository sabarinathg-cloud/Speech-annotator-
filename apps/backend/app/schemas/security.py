from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


ClientSecurityAction = Literal[
    "ATTEMPT_CONTEXT_MENU",
    "ATTEMPT_COPY",
    "ATTEMPT_DEVTOOLS",
    "ATTEMPT_PRINT",
    "ATTEMPT_SCREEN_CAPTURE",
    "ATTEMPT_SAVE_PAGE",
    "ATTEMPT_VIEW_SOURCE",
]


class ClientSecurityEventRequest(BaseModel):
    action: ClientSecurityAction
    metadata: dict[str, Any] = Field(default_factory=dict)


class SecurityAuditEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str | None = None
    actor_user_id: str | None = None
    actor_email: str | None = None
    actor_role: str | None = None
    action: str
    risk_level: str
    resource_type: str
    resource_id: str | None = None
    task_id: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    metadata: dict[str, Any]
    created_at: datetime


class SecurityAuditEventListResponse(BaseModel):
    items: list[SecurityAuditEventResponse]
    page: int
    page_size: int
    total: int

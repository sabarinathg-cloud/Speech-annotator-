from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel

from app.models.enums import TaskStatusEnum


class ExportJobRequest(BaseModel):
    format: Literal["csv", "xlsx"] = "csv"
    job_id: str | None = None
    status: TaskStatusEnum | None = None
    assignee_id: str | None = None
    language: str | None = None
    date_from: date | None = None
    date_to: date | None = None


class JobCreateResponse(BaseModel):
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    id: str
    job_id: str
    job_type: str
    status: str
    payload: dict[str, Any]
    result: dict[str, Any] | None = None
    error_message: str | None = None
    output_available: bool = False
    organization_id: str | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None

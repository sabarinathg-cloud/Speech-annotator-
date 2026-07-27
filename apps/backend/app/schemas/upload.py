from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import UploadJobStatusEnum


class TranscriptColumnMapping(BaseModel):
    source_key: str = Field(min_length=1, max_length=100)
    column_name: str = Field(min_length=1, max_length=255)
    source_label: str | None = Field(default=None, max_length=150)


class ColumnMappingRequest(BaseModel):
    id_column: str
    file_location_column: str
    transcript_columns: list[TranscriptColumnMapping]
    final_transcript_column: str | None = None
    notes_column: str | None = None
    status_column: str | None = None
    core_metadata_columns: dict[str, str] = Field(default_factory=dict)
    custom_metadata_columns: list[str] | None = None

    @model_validator(mode="after")
    def validate_transcripts(self) -> "ColumnMappingRequest":
        if not self.transcript_columns:
            raise ValueError("At least one transcript column is required")
        return self


class UploadFromPathRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2000)
    call_id_limit: int | None = Field(default=None, ge=1, le=100_000)
    call_id_column: str = Field(default="call_id", min_length=1, max_length=255)
    row_limit: int | None = Field(default=None, ge=1, le=1_000_000)

    @model_validator(mode="after")
    def validate_limit_mode(self) -> "UploadFromPathRequest":
        if self.call_id_limit is not None and self.row_limit is not None:
            raise ValueError("Use either call_id_limit or row_limit, not both")
        return self


class UploadFileResponse(BaseModel):
    id: str
    upload_job_id: str
    organization_id: str | None = None
    filename: str
    status: UploadJobStatusEnum


class PreviewResponse(BaseModel):
    upload_job_id: str
    organization_id: str | None = None
    columns: list[str]
    sample_rows: list[dict[str, Any]]
    row_count: int


class RowValidationError(BaseModel):
    row_number: int
    field_name: str | None = None
    error_message: str
    raw_value: str | None = None


class ValidationGateResult(BaseModel):
    gate_key: str
    status: str
    message: str
    checked_count: int | None = None
    failed_count: int | None = None


class UploadValidationResult(BaseModel):
    upload_job_id: str
    organization_id: str | None = None
    status: UploadJobStatusEnum
    valid_rows: int
    invalid_rows: int
    total_rows: int
    transcript_sources: list[str]
    custom_metadata_columns: list[str]
    import_allowed: bool
    gates: list[ValidationGateResult]
    errors: list[RowValidationError]


class UploadImportResult(BaseModel):
    upload_job_id: str
    organization_id: str | None = None
    imported_tasks: int
    skipped_rows: int
    status: UploadJobStatusEnum


class UploadJobErrorResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    row_number: int
    field_name: str | None
    error_message: str
    raw_value: str | None
    created_at: datetime

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator

from app.models.enums import TaskStatusEnum

AudioMaskMode = Literal["silence", "beep"]


class TranscriptVariantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source_key: str
    source_label: str
    transcript_text: str


class TaskListItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    external_id: str
    file_location: str
    status: TaskStatusEnum
    assignee_id: str | None
    assignee_name: str | None
    assignee_email: str | None
    last_tagger_id: str | None
    last_tagger_name: str | None
    last_tagger_email: str | None
    updated_at: datetime
    last_saved_at: datetime | None
    due_date: date | None
    language: str | None
    speaker_role: str | None
    version: int


class TaskListResponse(BaseModel):
    items: list[TaskListItemResponse]
    page: int
    page_size: int
    total: int
    status_counts: dict[str, int]


class PIIAnnotation(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=64)
    start: int = Field(ge=0)
    end: int = Field(ge=1)
    value: str = Field(min_length=1)
    source: str | None = Field(default=None, max_length=32)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_span(self) -> "PIIAnnotation":
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class AudioAlignmentWord(BaseModel):
    index: int = Field(ge=0)
    text: str
    normalized_text: str
    start_char: int = Field(ge=0)
    end_char: int = Field(ge=0)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(ge=0)
    score: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_alignment_span(self) -> "AudioAlignmentWord":
        if self.end_char < self.start_char:
            raise ValueError("end_char must be greater than or equal to start_char")
        if self.end_seconds < self.start_seconds:
            raise ValueError("end_seconds must be greater than or equal to start_seconds")
        return self


class AudioMaskInterval(BaseModel):
    id: str | None = None
    source_annotation_ids: list[str] | None = None
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(ge=0)
    labels: list[str] = Field(default_factory=list)
    text: str = ""

    @model_validator(mode="after")
    def validate_audio_interval(self) -> "AudioMaskInterval":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds must be greater than start_seconds")
        return self


class TaskDetailResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    external_id: str
    file_location: str
    final_transcript: str | None
    notes: str | None
    status: TaskStatusEnum
    speaker_gender: str | None
    speaker_role: str | None
    language: str | None
    channel: str | None
    duration_seconds: Decimal | None
    custom_metadata: dict[str, Any]
    original_row: dict[str, Any]
    pii_annotations: list[PIIAnnotation]
    assignee_id: str | None
    assignee_name: str | None
    assignee_email: str | None
    last_tagger_id: str | None
    last_tagger_name: str | None
    last_tagger_email: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    last_saved_at: datetime | None
    due_date: date | None
    transcript_variants: list[TranscriptVariantResponse]
    alignment_words: list[AudioAlignmentWord] = Field(default_factory=list)
    alignment_model: str | None = None
    alignment_updated_at: datetime | None = None
    masked_audio_available: bool = False
    masked_audio_updated_at: datetime | None = None
    masked_audio_intervals: list[AudioMaskInterval] = Field(default_factory=list)
    masked_audio_reference_intervals: list[AudioMaskInterval] = Field(default_factory=list)
    masked_audio_alignment_intervals: list[AudioMaskInterval] = Field(default_factory=list)
    masked_audio_mode: AudioMaskMode | None = None
    prev_task_id: str | None = None
    next_task_id: str | None = None

    @field_serializer("duration_seconds")
    def serialize_duration_seconds(self, value: Decimal | None) -> float | None:
        return float(value) if value is not None else None


class TaskPatchResponse(BaseModel):
    task: TaskDetailResponse


class ConflictResponse(BaseModel):
    detail: str = "Conflict detected. The task has been updated by another user."
    conflicting_fields: list[str]
    server_task: TaskDetailResponse


class UpdateTranscriptRequest(BaseModel):
    version: int = Field(ge=1)
    final_transcript: str


class UpdateMetadataRequest(BaseModel):
    version: int = Field(ge=1)
    speaker_gender: str | None = None
    speaker_role: str | None = None
    language: str | None = None
    channel: str | None = None
    duration_seconds: Decimal | None = None
    due_date: date | None = None
    custom_metadata: dict[str, Any] | None = None


class UpdateNotesRequest(BaseModel):
    version: int = Field(ge=1)
    notes: str | None = None


class UpdateStatusRequest(BaseModel):
    version: int = Field(ge=1)
    status: TaskStatusEnum
    comment: str | None = None


class UpdatePIIAnnotationsRequest(BaseModel):
    version: int = Field(ge=1)
    pii_annotations: list[PIIAnnotation]


class UpdateAssigneeRequest(BaseModel):
    version: int = Field(ge=1)
    assignee_id: str | None = None


class CreateAssignmentCopyRequest(BaseModel):
    version: int = Field(ge=1)
    assignee_id: str = Field(min_length=1)


class DetectPIIRequest(BaseModel):
    transcript: str
    include_ml: bool = False


class DetectPIIResponse(BaseModel):
    pii_annotations: list[PIIAnnotation]


class CombinedTaskUpdateRequest(BaseModel):
    version: int = Field(ge=1)
    final_transcript: str | None = None
    notes: str | None = None
    status: TaskStatusEnum | None = None
    comment: str | None = None
    speaker_gender: str | None = None
    speaker_role: str | None = None
    language: str | None = None
    channel: str | None = None
    duration_seconds: Decimal | None = None
    due_date: date | None = None
    custom_metadata: dict[str, Any] | None = None
    pii_annotations: list[PIIAnnotation] | None = None


class BulkAssigneeItem(BaseModel):
    task_id: str
    version: int = Field(ge=1)
    assignee_id: str | None = None


class BulkAssigneeRequest(BaseModel):
    assignments: list[BulkAssigneeItem] = Field(min_length=1, max_length=200)


class BulkAssigneeError(BaseModel):
    task_id: str
    status_code: int
    message: str


class BulkAssigneeUpdated(BaseModel):
    task: TaskDetailResponse


class BulkAssigneeResponse(BaseModel):
    updated: list[BulkAssigneeUpdated]
    errors: list[BulkAssigneeError]


class BulkTaskFilter(BaseModel):
    status: TaskStatusEnum | None = None
    search: str | None = Field(default=None, max_length=255)
    assignee_id: str | None = None
    job_id: str | None = None
    language: str | None = Field(default=None, max_length=100)
    date_from: date | None = None
    date_to: date | None = None


class BulkAutoBalanceRequest(BaseModel):
    filters: BulkTaskFilter = Field(default_factory=BulkTaskFilter)
    assignee_ids: list[str] = Field(min_length=1, max_length=100)
    max_tasks: int = Field(default=50000, ge=1, le=50000)


class BulkAutoBalanceResponse(BaseModel):
    matched_count: int
    updated_count: int
    skipped_count: int
    assignee_count: int


class BulkAssignmentCopyItem(BaseModel):
    task_id: str
    version: int = Field(ge=1)
    assignee_id: str = Field(min_length=1)


class BulkAssignmentCopyRequest(BaseModel):
    assignments: list[BulkAssignmentCopyItem] = Field(min_length=1, max_length=200)


class BulkAssignmentCopyResponse(BaseModel):
    created: list[BulkAssigneeUpdated]
    errors: list[BulkAssigneeError]


class BulkDueDateItem(BaseModel):
    task_id: str
    version: int = Field(ge=1)
    due_date: date | None = None


class BulkDueDateRequest(BaseModel):
    updates: list[BulkDueDateItem] = Field(min_length=1, max_length=200)


class BulkStatusItem(BaseModel):
    task_id: str
    version: int = Field(ge=1)


class BulkStatusRequest(BaseModel):
    status: TaskStatusEnum
    updates: list[BulkStatusItem] = Field(min_length=1, max_length=200)
    comment: str | None = None


class BulkTaskError(BaseModel):
    task_id: str
    status_code: int
    message: str


class BulkTaskUpdated(BaseModel):
    task: TaskDetailResponse


class BulkTaskResponse(BaseModel):
    updated: list[BulkTaskUpdated]
    errors: list[BulkTaskError]


class TaskActivityItem(BaseModel):
    id: str
    type: str
    action: str
    actor_user_id: str | None = None
    actor_email: str | None = None
    actor_name: str | None = None
    changed_at: datetime
    changed_fields: dict[str, Any] = Field(default_factory=dict)
    previous_values: dict[str, Any] = Field(default_factory=dict)
    new_values: dict[str, Any] = Field(default_factory=dict)
    old_status: TaskStatusEnum | None = None
    new_status: TaskStatusEnum | None = None
    comment: str | None = None


class TaskActivityResponse(BaseModel):
    items: list[TaskActivityItem]


class TaskNextResponse(BaseModel):
    task_id: str | None


class AudioURLResponse(BaseModel):
    url: str
    expires_in_seconds: int


class TaskAudioGroupChunkResponse(BaseModel):
    task_id: str
    external_id: str
    file_location: str
    filename: str
    chunk_index: int | None = None
    position: int
    status: TaskStatusEnum
    final_transcript: str | None = None
    has_transcript: bool
    duration_seconds: float | None = None


class TaskAudioGroupResponse(BaseModel):
    group_key: str | None = None
    group_label: str | None = None
    current_position: int
    current_chunk_index: int | None = None
    chunk_count: int
    completed_transcript_count: int
    missing_transcript_count: int
    assembled_transcript: str
    full_audio_url: str | None = None
    expires_in_seconds: int | None = None
    full_audio_available: bool
    message: str | None = None
    chunks: list[TaskAudioGroupChunkResponse]


class TaskAudioAlignmentResponse(BaseModel):
    task_id: str
    transcript_hash: str
    model: str
    words: list[AudioAlignmentWord]
    generated_at: datetime


class TaskMaskedAudioResponse(BaseModel):
    task_id: str
    masked_audio_url: str
    mask_mode: AudioMaskMode = "silence"
    expires_in_seconds: int
    masked_intervals: list[AudioMaskInterval]
    accepted_intervals: list[AudioMaskInterval] = Field(default_factory=list)
    alignment_intervals: list[AudioMaskInterval] = Field(default_factory=list)
    words: list[AudioAlignmentWord]
    generated_at: datetime


class TaskMaskAudioRequest(BaseModel):
    mask_intervals: list[AudioMaskInterval] | None = None

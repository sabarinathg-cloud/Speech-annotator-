from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.models.enums import (
    HiringAssessmentStatusEnum,
    HiringAssignmentStatusEnum,
    HiringDecisionEnum,
    HiringSubmissionValidationStatusEnum,
)
from app.schemas.task import PIIAnnotation

MetadataFieldType = Literal["text", "number", "date", "select"]


class HiringMetadataField(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=120)
    type: MetadataFieldType = "text"
    required: bool = False
    options: list[str] = Field(default_factory=list)
    sort_order: int = 0

    @model_validator(mode="after")
    def validate_options(self) -> "HiringMetadataField":
        if self.type == "select" and not self.options:
            raise ValueError("Select metadata fields require at least one option")
        return self


class HiringRubricField(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=120)
    max_score: float = Field(default=10, gt=0)
    required: bool = True
    sort_order: int = 0


class HiringPIIEntry(BaseModel):
    type: str = Field(min_length=1, max_length=80)
    value: str = Field(min_length=1, max_length=255)
    timestamp: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=500)


class HiringAssessmentCreateRequest(BaseModel):
    title: str = Field(min_length=2, max_length=255)
    instructions: str = ""
    due_date: date | None = None
    due_at: datetime | None = None
    time_limit_minutes: int | None = Field(default=None, ge=1, le=10080)
    blind_review_enabled: bool = False
    metadata_schema: list[HiringMetadataField] = Field(default_factory=list)
    pii_label_keys: list[str] = Field(default_factory=list)
    rubric_schema: list[HiringRubricField] = Field(default_factory=list)


class HiringAssessmentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=255)
    instructions: str | None = None
    status: HiringAssessmentStatusEnum | None = None
    due_date: date | None = None
    due_at: datetime | None = None
    time_limit_minutes: int | None = Field(default=None, ge=1, le=10080)
    blind_review_enabled: bool | None = None
    metadata_schema: list[HiringMetadataField] | None = None
    pii_label_keys: list[str] | None = None
    rubric_schema: list[HiringRubricField] | None = None

    @model_validator(mode="after")
    def validate_non_empty_update(self) -> "HiringAssessmentUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class HiringFolderImportRequest(BaseModel):
    folder_path: str = Field(min_length=1)
    recursive: bool = False


class HiringAudioBucketListRequest(BaseModel):
    root_path: str = Field(min_length=1)
    recursive: bool = False


class HiringAudioBucketResponse(BaseModel):
    name: str
    path: str
    wav_count: int


class HiringAudioBucketListResponse(BaseModel):
    root_path: str
    buckets: list[HiringAudioBucketResponse]


class HiringAssignmentCreateRequest(BaseModel):
    candidate_ids: list[str] = Field(min_length=1, max_length=200)


class HiringAssignmentAccessUpdateRequest(BaseModel):
    access_revoked: bool


class HiringAssignmentDeleteResponse(BaseModel):
    deleted_assignment_id: str


class HiringSubmissionUpdateRequest(BaseModel):
    version: int = Field(ge=1)
    final_transcript: str | None = None
    pii_annotations: list[PIIAnnotation] | None = None
    pii_text: str | None = None
    pii_entries: list[HiringPIIEntry] | None = None
    metadata_values: dict[str, Any] | None = None
    notes: str | None = None
    pii_reviewed: bool | None = None

    @model_validator(mode="after")
    def validate_non_empty_update(self) -> "HiringSubmissionUpdateRequest":
        if set(self.model_fields_set) == {"version"}:
            raise ValueError("At least one submission field must be provided")
        return self


class HiringSubmissionValidationRequest(BaseModel):
    validation_status: HiringSubmissionValidationStatusEnum
    validation_feedback: str | None = None


class HiringScorecardUpdateRequest(BaseModel):
    transcript_score: float | None = Field(default=None, ge=0)
    pii_score: float | None = Field(default=None, ge=0)
    metadata_score: float | None = Field(default=None, ge=0)
    total_score: float | None = Field(default=None, ge=0)
    rubric_scores: dict[str, float | None] = Field(default_factory=dict)
    decision: HiringDecisionEnum = HiringDecisionEnum.PENDING
    evaluator_notes: str | None = None


class HiringAssessmentItemReferenceUpdateRequest(BaseModel):
    reference_transcript: str | None = None
    reference_pii_entries: list[HiringPIIEntry] = Field(default_factory=list)
    reference_metadata: dict[str, Any] | None = None


class HiringImportResponse(BaseModel):
    imported_items: int
    skipped_items: int = 0
    errors: list[str] = Field(default_factory=list)


class HiringTranscriptSubstitution(BaseModel):
    expected: str
    actual: str


class HiringPIIComparisonMismatch(BaseModel):
    expected: HiringPIIEntry
    actual: HiringPIIEntry


class HiringReferenceMetrics(BaseModel):
    word_error_rate: float | None = None
    edit_distance: int | None = None
    reference_word_count: int = 0
    transcript_accuracy_percent: float | None = None
    suggested_transcript_score: float | None = None
    suggested_transcript_score_max: float | None = None
    transcript_missing_words: list[str] = Field(default_factory=list)
    transcript_extra_words: list[str] = Field(default_factory=list)
    transcript_substitutions: list[HiringTranscriptSubstitution] = Field(default_factory=list)
    pii_expected_count: int = 0
    pii_candidate_count: int = 0
    pii_matched_count: int = 0
    pii_missing: list[HiringPIIEntry] = Field(default_factory=list)
    pii_extra: list[HiringPIIEntry] = Field(default_factory=list)
    pii_type_mismatches: list[HiringPIIComparisonMismatch] = Field(default_factory=list)


class HiringAssessmentItemResponse(BaseModel):
    id: str
    external_id: str
    assignment_id: str | None = None
    original_filename: str
    original_source: str
    sort_order: int
    created_at: datetime
    reference_transcript: str | None = None
    reference_pii_annotations: list[PIIAnnotation] = Field(default_factory=list)
    reference_pii_entries: list[HiringPIIEntry] = Field(default_factory=list)
    reference_metadata: dict[str, Any] = Field(default_factory=dict)


class HiringSubmissionResponse(BaseModel):
    id: str
    item_id: str
    version: int
    final_transcript: str
    pii_annotations: list[PIIAnnotation]
    pii_text: str
    pii_entries: list[HiringPIIEntry]
    metadata_values: dict[str, Any]
    notes: str
    pii_reviewed: bool
    validation_status: HiringSubmissionValidationStatusEnum
    validation_feedback: str | None
    last_saved_at: datetime | None
    submitted_at: datetime | None
    reference_metrics: HiringReferenceMetrics | None = None


class HiringAssessmentSummaryResponse(BaseModel):
    id: str
    title: str
    instructions: str
    status: HiringAssessmentStatusEnum
    due_date: date | None
    due_at: datetime | None
    time_limit_minutes: int | None
    blind_review_enabled: bool
    metadata_schema: list[HiringMetadataField]
    pii_label_keys: list[str]
    rubric_schema: list[HiringRubricField]
    item_count: int
    assignment_count: int
    created_at: datetime
    updated_at: datetime


class HiringAssessmentDetailResponse(HiringAssessmentSummaryResponse):
    items: list[HiringAssessmentItemResponse]


class HiringAssessmentListResponse(BaseModel):
    items: list[HiringAssessmentSummaryResponse]


class HiringAssignmentSummaryResponse(BaseModel):
    id: str
    assessment_id: str
    assessment_title: str
    candidate_id: str
    candidate_name: str
    candidate_email: str
    candidate_label: str
    candidate_identity_hidden: bool = False
    status: HiringAssignmentStatusEnum
    decision: HiringDecisionEnum
    access_revoked: bool = False
    due_date: date | None
    due_at: datetime | None
    item_count: int
    submitted_count: int
    validated_count: int
    rejected_count: int
    assigned_at: datetime
    started_at: datetime | None
    submitted_at: datetime | None
    evaluated_at: datetime | None
    time_limit_expires_at: datetime | None
    submission_deadline_at: datetime | None
    seconds_remaining: int | None
    last_saved_at: datetime | None
    invite_url: str | None = None
    invite_expires_at: datetime | None = None
    total_score: float | None


class HiringAssignmentListResponse(BaseModel):
    items: list[HiringAssignmentSummaryResponse]


class HiringCandidateAssignmentDetailResponse(BaseModel):
    id: str
    assessment: HiringAssessmentSummaryResponse
    status: HiringAssignmentStatusEnum
    decision: HiringDecisionEnum
    access_revoked: bool = False
    started_at: datetime | None
    submitted_at: datetime | None
    time_limit_expires_at: datetime | None
    submission_deadline_at: datetime | None
    seconds_remaining: int | None
    items: list[HiringAssessmentItemResponse]
    submissions: list[HiringSubmissionResponse]


class HiringAdminAssignmentReviewResponse(HiringCandidateAssignmentDetailResponse):
    candidate_id: str
    candidate_name: str
    candidate_email: str
    transcript_score: float | None
    pii_score: float | None
    metadata_score: float | None
    total_score: float | None
    rubric_scores: dict[str, float | None]
    evaluator_notes: str | None


class HiringAssignmentInviteResponse(BaseModel):
    assignment_id: str
    candidate_email: str
    candidate_name: str
    temporary_password: str
    invite_url: str
    invite_expires_at: datetime


class HiringAuditEventResponse(BaseModel):
    id: str
    actor_email: str | None
    actor_role: str | None
    action: str
    resource_type: str
    resource_id: str | None
    metadata: dict[str, Any]
    created_at: datetime


class HiringAuditEventListResponse(BaseModel):
    items: list[HiringAuditEventResponse]


class HiringRankingItem(BaseModel):
    rank: int
    assignment_id: str
    candidate_id: str
    candidate_name: str
    candidate_email: str
    candidate_label: str
    candidate_identity_hidden: bool = False
    status: HiringAssignmentStatusEnum
    decision: HiringDecisionEnum
    submitted_at: datetime | None
    evaluated_at: datetime | None
    total_score: float | None
    progress_percent: float
    validated_count: int
    rejected_count: int
    item_count: int
    time_spent_seconds: int | None


class HiringRankingResponse(BaseModel):
    items: list[HiringRankingItem]

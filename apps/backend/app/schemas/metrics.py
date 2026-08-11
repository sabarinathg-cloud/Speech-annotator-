from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.enums import TaskStatusEnum


class MetricsFilters(BaseModel):
    status: TaskStatusEnum | None = None
    assignee_id: str | None = None
    job_id: str | None = None
    language: str | None = None
    date_from: date | None = None
    date_to: date | None = None


class MetricsOverview(BaseModel):
    total_tasks: int
    scored_tasks: int
    scored_pairs: int
    average_wer: float | None
    average_cer: float | None
    total_pii_annotations: int
    low_confidence_annotations: int
    overlap_warnings: int


class ModelTranscriptMetric(BaseModel):
    source_key: str
    source_label: str
    tasks_scored: int
    word_errors: int
    reference_words: int
    character_errors: int
    reference_characters: int
    average_wer: float | None
    average_cer: float | None


class ModelBenchmarkMetric(BaseModel):
    rank: int
    source_key: str
    source_label: str
    group_key: str
    group_label: str
    tasks_scored: int
    word_errors: int
    reference_words: int
    character_errors: int
    reference_characters: int
    average_wer: float | None
    average_cer: float | None
    word_accuracy: float | None
    character_accuracy: float | None


class ModelBenchmarkSummary(BaseModel):
    best_model_source_key: str | None
    best_model_source_label: str | None
    best_model_average_wer: float | None
    ranking: list[ModelBenchmarkMetric]
    by_language: list[ModelBenchmarkMetric]
    by_duration_bucket: list[ModelBenchmarkMetric]


class PIIMetrics(BaseModel):
    total_annotations: int
    average_annotations_per_task: float
    low_confidence_annotations: int
    overlap_warnings: int
    by_label: dict[str, int]
    by_source: dict[str, int]


class MaskingMetrics(BaseModel):
    masked_tasks: int
    scored_masked_tasks: int
    scored_intervals: int
    average_onset_error_ms: int | None
    average_offset_error_ms: int | None
    leaked_audio_duration_ms: int
    over_masked_duration_ms: int
    unscored_masked_tasks: int
    alignment_adjusted_tasks: int
    alignment_adjusted_intervals: int
    average_alignment_onset_adjustment_ms: int | None
    average_alignment_offset_adjustment_ms: int | None
    alignment_trimmed_duration_ms: int
    alignment_expanded_duration_ms: int


class MaskingTaskMetric(BaseModel):
    task_id: str
    external_id: str
    status: TaskStatusEnum
    language: str | None
    upload_job_id: str
    assignee_name: str | None
    last_tagger_name: str | None
    onset_error_ms: int | None
    offset_error_ms: int | None
    leaked_audio_duration_ms: int
    over_masked_duration_ms: int
    risk_duration_ms: int
    scored_intervals: int
    alignment_adjustment_ms: int
    alignment_trimmed_duration_ms: int
    alignment_expanded_duration_ms: int


class MaskingIntervalMetric(BaseModel):
    task_id: str
    external_id: str
    status: TaskStatusEnum
    language: str | None
    upload_job_id: str
    interval_id: str | None
    label: str
    text: str
    accepted_start_seconds: float
    accepted_end_seconds: float
    actual_start_seconds: float
    actual_end_seconds: float
    alignment_start_seconds: float | None
    alignment_end_seconds: float | None
    leaked_audio_duration_ms: int
    over_masked_duration_ms: int
    alignment_onset_delta_ms: int | None
    alignment_offset_delta_ms: int | None
    alignment_trimmed_duration_ms: int
    alignment_expanded_duration_ms: int
    risk_duration_ms: int


class TaggerMetric(BaseModel):
    user_id: str | None
    user_name: str | None
    user_email: str | None
    tasks_touched: int
    completed_tasks: int
    reviewed_tasks: int
    approved_tasks: int
    pii_annotations: int


class UserProductivityMetric(BaseModel):
    user_id: str
    user_name: str
    user_email: str
    role: str
    is_active: bool
    assigned_tasks: int
    open_assigned_tasks: int
    tasks_touched: int
    completed_tasks: int
    reviewed_tasks: int
    approved_tasks: int
    pii_annotations: int
    average_completion_minutes: float | None
    completed_turnaround_count: int
    task_audit_events: int
    security_events: int
    high_risk_security_events: int
    last_login_at: datetime | None
    last_activity_at: datetime | None
    active_session_started_at: datetime | None
    active_session_minutes: int | None
    idle_minutes: int | None
    tracked_active_minutes: int
    tracked_task_active_minutes: int
    tracked_idle_minutes: int
    tracked_total_minutes: int
    completed_tasks_in_period: int
    completed_tasks_today: int
    average_active_minutes_per_segment: float | None
    efficiency_segments_per_active_hour: float | None
    focus_rate: float | None


class ActivityHeartbeatRequest(BaseModel):
    task_id: str | None = None
    route: str | None = Field(default=None, max_length=500)
    active_seconds: int = Field(default=0, ge=0, le=300)
    idle_seconds: int = Field(default=0, ge=0, le=300)
    event_count: int = Field(default=0, ge=0, le=10000)
    started_at: datetime
    ended_at: datetime


class ActivityHeartbeatResponse(BaseModel):
    recorded: bool


class PeopleActivitySummary(BaseModel):
    active_seconds: int
    task_active_seconds: int
    idle_seconds: int
    total_tracked_seconds: int
    completed_segments: int
    average_active_seconds_per_segment: float | None
    efficiency_segments_per_active_hour: float | None
    focus_rate: float | None
    last_activity_at: datetime | None


class PeopleActivityDaily(PeopleActivitySummary):
    date: date


class PeopleActivityOrganization(PeopleActivitySummary):
    organization_id: str
    organization_name: str
    organization_slug: str


class PeopleActivityUser(BaseModel):
    user_id: str
    user_name: str
    user_email: str
    role: str
    is_active: bool
    overall: PeopleActivitySummary
    daily: list[PeopleActivityDaily]
    organizations: list[PeopleActivityOrganization]


class PeopleActivityResponse(BaseModel):
    generated_at: datetime
    date_from: date
    date_to: date
    overall: PeopleActivitySummary
    daily: list[PeopleActivityDaily]
    items: list[PeopleActivityUser]


class TaskSourceErrorMetric(BaseModel):
    source_key: str
    source_label: str
    wer: float | None
    cer: float | None
    word_errors: int
    reference_words: int
    character_errors: int
    reference_characters: int


class WorstTaskMetric(BaseModel):
    task_id: str
    external_id: str
    status: TaskStatusEnum
    language: str | None
    upload_job_id: str
    assignee_name: str | None
    last_tagger_name: str | None
    max_wer: float | None
    average_wer: float | None
    source_metrics: list[TaskSourceErrorMetric]


class AdminMetricsResponse(BaseModel):
    generated_at: datetime
    filters: MetricsFilters
    overview: MetricsOverview
    status_counts: dict[str, int]
    model_metrics: list[ModelTranscriptMetric]
    model_benchmarks: ModelBenchmarkSummary
    pii_metrics: PIIMetrics
    masking_metrics: MaskingMetrics
    tagger_metrics: list[TaggerMetric]
    user_metrics: list[UserProductivityMetric]
    worst_tasks: list[WorstTaskMetric]
    worst_masking_tasks: list[MaskingTaskMetric]
    masking_interval_drilldowns: list[MaskingIntervalMetric]

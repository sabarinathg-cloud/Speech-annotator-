export type Role = "ADMIN" | "ANNOTATOR" | "REVIEWER" | "CANDIDATE";

export type UserStatusFilter = "all" | "active" | "inactive";
export type AssignmentLoad = "none" | "light" | "normal" | "heavy";

export type TaskStatus =
  | "Not Started"
  | "In Progress"
  | "Completed"
  | "Needs Review"
  | "Reviewed"
  | "Approved"
  | "Rejected";

export type TaskWorkflowType = "TRANSCRIPT_CORRECTION" | "AUDIO_COMPARISON";

export type QuestionnaireFieldType =
  | "yes_no"
  | "single_select"
  | "multi_select"
  | "short_text"
  | "long_text"
  | "number"
  | "rating"
  | "date";

export interface QuestionnaireQuestion {
  id: string;
  label: string;
  field_type: QuestionnaireFieldType;
  help_text: string | null;
  required: boolean;
  options: string[];
  sort_order: number;
  scoring_key: string | null;
}

export type QuestionnaireAnswerValue = string | number | boolean | string[] | null;
export type QuestionnaireAnswers = Record<string, QuestionnaireAnswerValue>;

export interface OrganizationQuestionnaire {
  id: string | null;
  organization_id: string;
  title: string;
  description: string | null;
  questions: QuestionnaireQuestion[];
  version: number;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrganizationQuestionnaireUpsertRequest {
  title: string;
  description?: string | null;
  questions: QuestionnaireQuestion[];
  is_active?: boolean;
}

export interface OrganizationSettings {
  metadata_enabled: boolean;
  pii_enabled: boolean;
  transcript_redaction_enabled: boolean;
  audio_masking_enabled: boolean;
  hiring_enabled: boolean;
  instructions: string | null;
}

export interface Organization extends OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserOrganizationAccess {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  settings: OrganizationSettings;
}

export interface OrganizationMembership {
  user_id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  membership_active: boolean;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  confidentiality_acknowledged_at?: string | null;
  confidentiality_acknowledged_version?: string | null;
  confidentiality_acknowledged_for_session?: boolean;
  organizations?: UserOrganizationAccess[];
  default_organization_id?: string | null;
}

export type ClientSecurityAction =
  | "ATTEMPT_CONTEXT_MENU"
  | "ATTEMPT_COPY"
  | "ATTEMPT_DEVTOOLS"
  | "ATTEMPT_PRINT"
  | "ATTEMPT_SCREEN_CAPTURE"
  | "ATTEMPT_SAVE_PAGE"
  | "ATTEMPT_VIEW_SOURCE";

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  user: User;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface ChangePasswordResponse {
  message: string;
}

export interface TranscriptVariant {
  id: string;
  source_key: string;
  source_label: string;
  transcript_text: string;
}

export interface PIIAnnotation {
  id: string;
  label: string;
  start: number;
  end: number;
  value: string;
  source: string | null;
  confidence: number | null;
}

export interface DetectPIIResponse {
  pii_annotations: PIIAnnotation[];
}

export interface AudioAlignmentWord {
  index: number;
  text: string;
  normalized_text: string;
  start_char: number;
  end_char: number;
  start_seconds: number;
  end_seconds: number;
  score: number | null;
}

export interface AudioMaskInterval {
  id?: string | null;
  source_annotation_ids?: string[] | null;
  start_seconds: number;
  end_seconds: number;
  labels: string[];
  text: string;
}

export type AudioMaskMode = "silence" | "beep";

export interface PIILabel {
  id: string;
  organization_id?: string;
  key: string;
  display_name: string;
  color: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PIILabelCreateRequest {
  key: string;
  display_name: string;
  color?: string;
  description?: string | null;
  is_active?: boolean;
  sort_order?: number | null;
}

export interface PIILabelUpdateRequest {
  display_name?: string | null;
  color?: string | null;
  description?: string | null;
  is_active?: boolean | null;
  sort_order?: number | null;
}

export interface TaskDetail {
  id: string;
  organization_id?: string;
  organization_name?: string | null;
  external_id: string;
  workflow_type: TaskWorkflowType;
  file_location: string;
  comparison_audio_location: string | null;
  questionnaire_id: string | null;
  questionnaire_snapshot: Record<string, unknown>;
  questionnaire_answers: QuestionnaireAnswers;
  final_transcript: string | null;
  notes: string | null;
  status: TaskStatus;
  speaker_gender: string | null;
  speaker_role: string | null;
  language: string | null;
  channel: string | null;
  duration_seconds: number | null;
  custom_metadata: Record<string, unknown>;
  original_row: Record<string, unknown>;
  pii_annotations: PIIAnnotation[];
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  last_tagger_id: string | null;
  last_tagger_name: string | null;
  last_tagger_email: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_saved_at: string | null;
  due_date: string | null;
  transcript_variants: TranscriptVariant[];
  alignment_words: AudioAlignmentWord[];
  alignment_model: string | null;
  alignment_updated_at: string | null;
  masked_audio_available: boolean;
  masked_audio_updated_at: string | null;
  masked_audio_intervals: AudioMaskInterval[];
  masked_audio_reference_intervals: AudioMaskInterval[];
  masked_audio_alignment_intervals: AudioMaskInterval[];
  masked_audio_mode: AudioMaskMode | null;
  prev_task_id: string | null;
  next_task_id: string | null;
}

export interface TaskListItem {
  id: string;
  organization_id?: string;
  organization_name?: string | null;
  external_id: string;
  workflow_type: TaskWorkflowType;
  file_location: string;
  comparison_audio_location: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  last_tagger_id: string | null;
  last_tagger_name: string | null;
  last_tagger_email: string | null;
  updated_at: string;
  last_saved_at: string | null;
  due_date: string | null;
  language: string | null;
  speaker_role: string | null;
  version: number;
}

export interface TaskListResponse {
  items: TaskListItem[];
  page: number;
  page_size: number;
  total: number;
  status_counts: Record<string, number>;
}

export interface BulkTaskFilter {
  status?: TaskStatus | null;
  search?: string | null;
  assignee_id?: string | null;
  job_id?: string | null;
  language?: string | null;
  date_from?: string | null;
  date_to?: string | null;
}

export interface BulkAutoBalanceRequest {
  filters: BulkTaskFilter;
  assignee_ids: string[];
  max_tasks?: number;
}

export interface BulkAutoBalanceResponse {
  matched_count: number;
  updated_count: number;
  skipped_count: number;
  assignee_count: number;
  protected_call_count: number;
  protected_task_count: number;
}

export interface BulkCallSplitRequest {
  filters: BulkTaskFilter;
  assignee_ids: string[];
  calls_per_assignee: number;
  call_id_column?: string;
  max_tasks?: number;
}

export interface BulkCallSplitAssignment {
  assignee_id: string;
  assignee_name: string;
  assignee_email: string;
  call_count: number;
  task_count: number;
}

export interface BulkCallSplitResponse {
  matched_count: number;
  matched_call_count: number;
  updated_count: number;
  skipped_count: number;
  assignee_count: number;
  calls_per_assignee: number;
  call_id_column: string;
  protected_call_count: number;
  protected_task_count: number;
  assignments: BulkCallSplitAssignment[];
}

export interface TaskAudioGroupChunk {
  task_id: string;
  external_id: string;
  file_location: string;
  filename: string;
  chunk_index: number | null;
  position: number;
  status: TaskStatus;
  final_transcript: string | null;
  has_transcript: boolean;
  duration_seconds: number | null;
  seed_transcript: string | null;
  seed_source_key: string | null;
  seed_source_label: string | null;
}

export type TaskFullTranscriptSource = "saved_review" | "segment_asr_seed";

export interface TaskAudioGroup {
  group_key: string | null;
  group_label: string | null;
  current_position: number;
  current_chunk_index: number | null;
  chunk_count: number;
  completed_transcript_count: number;
  missing_transcript_count: number;
  assembled_transcript: string;
  full_transcript_text: string;
  full_transcript_source: TaskFullTranscriptSource;
  full_transcript_review_version: number | null;
  full_transcript_review_updated_at: string | null;
  full_transcript_seed_missing_count: number;
  full_transcript_seed_source_counts: Record<string, number>;
  full_audio_url: string | null;
  expires_in_seconds: number | null;
  full_audio_available: boolean;
  message: string | null;
  chunks: TaskAudioGroupChunk[];
}

export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  last_login_at: string | null;
  last_activity_at: string | null;
  assigned_task_count: number;
  open_assigned_task_count: number;
  completed_task_count: number;
  approved_task_count: number;
  assignment_load: AssignmentLoad;
  organizations?: UserOrganizationAccess[];
  created_at: string;
  updated_at: string;
}

export interface SecurityAuditEvent {
  id: string;
  organization_id?: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  risk_level: "low" | "medium" | "high" | string;
  resource_type: string;
  resource_id: string | null;
  task_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SecurityAuditEventListResponse {
  items: SecurityAuditEvent[];
  page: number;
  page_size: number;
  total: number;
}

export interface ColumnMappingRequest {
  workflow_type?: TaskWorkflowType;
  id_column: string;
  file_location_column: string;
  comparison_audio_column?: string | null;
  transcript_columns: Array<{
    source_key: string;
    column_name: string;
    source_label?: string | null;
  }>;
  final_transcript_column?: string | null;
  notes_column?: string | null;
  status_column?: string | null;
  core_metadata_columns?: Record<string, string>;
  custom_metadata_columns?: string[] | null;
}

export interface UploadValidationError {
  row_number: number;
  field_name: string | null;
  error_message: string;
  raw_value: string | null;
}

export interface ValidationGateResult {
  gate_key: string;
  status: "pass" | "warning" | "fail";
  message: string;
  checked_count: number | null;
  failed_count: number | null;
}

export interface UploadValidationResult {
  upload_job_id: string;
  organization_id?: string;
  status: string;
  valid_rows: number;
  invalid_rows: number;
  total_rows: number;
  transcript_sources: string[];
  custom_metadata_columns: string[];
  import_allowed: boolean;
  gates: ValidationGateResult[];
  errors: UploadValidationError[];
}

export interface JobStatus {
  id: string;
  organization_id?: string | null;
  job_id: string;
  job_type: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  output_available: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskAudioAlignmentResponse {
  task_id: string;
  transcript_hash: string;
  model: string;
  words: AudioAlignmentWord[];
  generated_at: string;
}

export interface TaskMaskedAudioResponse {
  task_id: string;
  masked_audio_url: string;
  mask_mode: AudioMaskMode;
  expires_in_seconds: number;
  masked_intervals: AudioMaskInterval[];
  accepted_intervals: AudioMaskInterval[];
  alignment_intervals: AudioMaskInterval[];
  words: AudioAlignmentWord[];
  generated_at: string;
}

export interface MetricsFilters {
  status: TaskStatus | null;
  assignee_id: string | null;
  job_id: string | null;
  language: string | null;
  date_from: string | null;
  date_to: string | null;
}

export interface MetricsOverview {
  total_tasks: number;
  scored_tasks: number;
  scored_pairs: number;
  average_wer: number | null;
  average_cer: number | null;
  total_pii_annotations: number;
  low_confidence_annotations: number;
  overlap_warnings: number;
}

export interface ModelTranscriptMetric {
  source_key: string;
  source_label: string;
  tasks_scored: number;
  word_errors: number;
  reference_words: number;
  character_errors: number;
  reference_characters: number;
  average_wer: number | null;
  average_cer: number | null;
}

export interface ModelBenchmarkMetric {
  rank: number;
  source_key: string;
  source_label: string;
  group_key: string;
  group_label: string;
  tasks_scored: number;
  word_errors: number;
  reference_words: number;
  character_errors: number;
  reference_characters: number;
  average_wer: number | null;
  average_cer: number | null;
  word_accuracy: number | null;
  character_accuracy: number | null;
}

export interface ModelBenchmarkSummary {
  best_model_source_key: string | null;
  best_model_source_label: string | null;
  best_model_average_wer: number | null;
  ranking: ModelBenchmarkMetric[];
  by_language: ModelBenchmarkMetric[];
  by_duration_bucket: ModelBenchmarkMetric[];
}

export interface PIIMetrics {
  total_annotations: number;
  average_annotations_per_task: number;
  low_confidence_annotations: number;
  overlap_warnings: number;
  by_label: Record<string, number>;
  by_source: Record<string, number>;
}

export interface MaskingMetrics {
  masked_tasks: number;
  scored_masked_tasks: number;
  scored_intervals: number;
  average_onset_error_ms: number | null;
  average_offset_error_ms: number | null;
  leaked_audio_duration_ms: number;
  over_masked_duration_ms: number;
  unscored_masked_tasks: number;
  alignment_adjusted_tasks: number;
  alignment_adjusted_intervals: number;
  average_alignment_onset_adjustment_ms: number | null;
  average_alignment_offset_adjustment_ms: number | null;
  alignment_trimmed_duration_ms: number;
  alignment_expanded_duration_ms: number;
}

export interface MaskingTaskMetric {
  task_id: string;
  external_id: string;
  status: TaskStatus;
  language: string | null;
  upload_job_id: string;
  assignee_name: string | null;
  last_tagger_name: string | null;
  onset_error_ms: number | null;
  offset_error_ms: number | null;
  leaked_audio_duration_ms: number;
  over_masked_duration_ms: number;
  risk_duration_ms: number;
  scored_intervals: number;
  alignment_adjustment_ms: number;
  alignment_trimmed_duration_ms: number;
  alignment_expanded_duration_ms: number;
}

export interface MaskingIntervalMetric {
  task_id: string;
  external_id: string;
  status: TaskStatus;
  language: string | null;
  upload_job_id: string;
  interval_id: string | null;
  label: string;
  text: string;
  accepted_start_seconds: number;
  accepted_end_seconds: number;
  actual_start_seconds: number;
  actual_end_seconds: number;
  alignment_start_seconds: number | null;
  alignment_end_seconds: number | null;
  leaked_audio_duration_ms: number;
  over_masked_duration_ms: number;
  alignment_onset_delta_ms: number | null;
  alignment_offset_delta_ms: number | null;
  alignment_trimmed_duration_ms: number;
  alignment_expanded_duration_ms: number;
  risk_duration_ms: number;
}

export interface TaggerMetric {
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  tasks_touched: number;
  completed_tasks: number;
  reviewed_tasks: number;
  approved_tasks: number;
  pii_annotations: number;
}

export interface UserProductivityMetric {
  user_id: string;
  user_name: string;
  user_email: string;
  role: Role;
  is_active: boolean;
  assigned_tasks: number;
  open_assigned_tasks: number;
  tasks_touched: number;
  completed_tasks: number;
  reviewed_tasks: number;
  approved_tasks: number;
  pii_annotations: number;
  average_completion_minutes: number | null;
  completed_turnaround_count: number;
  task_audit_events: number;
  security_events: number;
  high_risk_security_events: number;
  last_login_at: string | null;
  last_activity_at: string | null;
  active_session_started_at: string | null;
  active_session_minutes: number | null;
  idle_minutes: number | null;
  tracked_active_minutes: number;
  tracked_task_active_minutes: number;
  tracked_idle_minutes: number;
  tracked_total_minutes: number;
  completed_tasks_in_period: number;
  completed_tasks_today: number;
  average_active_minutes_per_segment: number | null;
  efficiency_segments_per_active_hour: number | null;
  focus_rate: number | null;
}

export interface ActivityHeartbeatRequest {
  task_id?: string | null;
  route?: string | null;
  active_seconds: number;
  idle_seconds: number;
  event_count: number;
  started_at: string;
  ended_at: string;
}

export interface ActivityHeartbeatResponse {
  recorded: boolean;
}

export interface TaskSourceErrorMetric {
  source_key: string;
  source_label: string;
  wer: number | null;
  cer: number | null;
  word_errors: number;
  reference_words: number;
  character_errors: number;
  reference_characters: number;
}

export interface WorstTaskMetric {
  task_id: string;
  external_id: string;
  status: TaskStatus;
  language: string | null;
  upload_job_id: string;
  assignee_name: string | null;
  last_tagger_name: string | null;
  max_wer: number | null;
  average_wer: number | null;
  source_metrics: TaskSourceErrorMetric[];
}

export interface AdminMetricsResponse {
  generated_at: string;
  filters: MetricsFilters;
  overview: MetricsOverview;
  status_counts: Record<string, number>;
  model_metrics: ModelTranscriptMetric[];
  model_benchmarks: ModelBenchmarkSummary;
  pii_metrics: PIIMetrics;
  masking_metrics: MaskingMetrics;
  tagger_metrics: TaggerMetric[];
  user_metrics: UserProductivityMetric[];
  worst_tasks: WorstTaskMetric[];
  worst_masking_tasks: MaskingTaskMetric[];
  masking_interval_drilldowns: MaskingIntervalMetric[];
}

export type HiringAssessmentStatus = "DRAFT" | "ACTIVE" | "CLOSED";
export type HiringAssignmentStatus = "ASSIGNED" | "IN_PROGRESS" | "SUBMITTED" | "EVALUATED";
export type HiringSubmissionValidationStatus = "PENDING" | "VALIDATED" | "REJECTED";
export type HiringDecision = "PENDING" | "PASS" | "FAIL" | "HOLD";
export type HiringMetadataFieldType = "text" | "number" | "date" | "select";

export interface HiringMetadataField {
  key: string;
  label: string;
  type: HiringMetadataFieldType;
  required: boolean;
  options: string[];
  sort_order: number;
}

export interface HiringRubricField {
  key: string;
  label: string;
  max_score: number;
  required: boolean;
  sort_order: number;
}

export interface HiringPIIEntry {
  type: string;
  value: string;
  timestamp: string | null;
  notes: string | null;
}

export interface HiringAssessmentSummary {
  id: string;
  organization_id?: string;
  organization_name?: string | null;
  title: string;
  instructions: string;
  status: HiringAssessmentStatus;
  due_date: string | null;
  due_at: string | null;
  time_limit_minutes: number | null;
  blind_review_enabled: boolean;
  metadata_schema: HiringMetadataField[];
  pii_label_keys: string[];
  rubric_schema: HiringRubricField[];
  item_count: number;
  assignment_count: number;
  created_at: string;
  updated_at: string;
}

export interface HiringAssessmentItem {
  id: string;
  external_id: string;
  assignment_id: string | null;
  original_filename: string;
  original_source: string;
  sort_order: number;
  created_at: string;
  reference_transcript: string | null;
  reference_pii_annotations: PIIAnnotation[];
  reference_pii_entries: HiringPIIEntry[];
  reference_metadata: Record<string, unknown>;
}

export interface HiringAssessmentDetail extends HiringAssessmentSummary {
  items: HiringAssessmentItem[];
}

export interface HiringAssessmentListResponse {
  items: HiringAssessmentSummary[];
}

export interface HiringAssessmentDeleteResponse {
  deleted_assessment_id: string;
  deleted_items: number;
  deleted_assignments: number;
}

export interface HiringAssignmentSummary {
  id: string;
  organization_id?: string;
  organization_name?: string | null;
  assessment_id: string;
  assessment_title: string;
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  candidate_label: string;
  candidate_identity_hidden: boolean;
  status: HiringAssignmentStatus;
  decision: HiringDecision;
  access_revoked: boolean;
  due_date: string | null;
  due_at: string | null;
  item_count: number;
  submitted_count: number;
  validated_count: number;
  rejected_count: number;
  assigned_at: string;
  started_at: string | null;
  submitted_at: string | null;
  evaluated_at: string | null;
  time_limit_expires_at: string | null;
  submission_deadline_at: string | null;
  seconds_remaining: number | null;
  last_saved_at: string | null;
  invite_url: string | null;
  invite_expires_at: string | null;
  total_score: number | null;
}

export interface HiringAssignmentListResponse {
  items: HiringAssignmentSummary[];
}

export interface HiringReferenceMetrics {
  word_error_rate: number | null;
  edit_distance: number | null;
  reference_word_count: number;
  transcript_accuracy_percent: number | null;
  suggested_transcript_score: number | null;
  suggested_transcript_score_max: number | null;
  transcript_missing_words: string[];
  transcript_extra_words: string[];
  transcript_substitutions: { expected: string; actual: string }[];
  pii_expected_count: number;
  pii_candidate_count: number;
  pii_matched_count: number;
  pii_missing: HiringPIIEntry[];
  pii_extra: HiringPIIEntry[];
  pii_type_mismatches: { expected: HiringPIIEntry; actual: HiringPIIEntry }[];
}

export interface HiringSubmission {
  id: string;
  item_id: string;
  version: number;
  final_transcript: string;
  pii_annotations: PIIAnnotation[];
  pii_text: string;
  pii_entries: HiringPIIEntry[];
  metadata_values: Record<string, unknown>;
  notes: string;
  pii_reviewed: boolean;
  validation_status: HiringSubmissionValidationStatus;
  validation_feedback: string | null;
  last_saved_at: string | null;
  submitted_at: string | null;
  reference_metrics: HiringReferenceMetrics | null;
}

export interface HiringCandidateAssignmentDetail {
  id: string;
  assessment: HiringAssessmentSummary;
  status: HiringAssignmentStatus;
  decision: HiringDecision;
  access_revoked: boolean;
  started_at: string | null;
  submitted_at: string | null;
  time_limit_expires_at: string | null;
  submission_deadline_at: string | null;
  seconds_remaining: number | null;
  items: HiringAssessmentItem[];
  submissions: HiringSubmission[];
}

export interface HiringAdminAssignmentReview extends HiringCandidateAssignmentDetail {
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  transcript_score: number | null;
  pii_score: number | null;
  metadata_score: number | null;
  total_score: number | null;
  rubric_scores: Record<string, number | null>;
  evaluator_notes: string | null;
}

export interface HiringAssignmentInviteResponse {
  assignment_id: string;
  candidate_email: string;
  candidate_name: string;
  temporary_password: string;
  invite_url: string;
  invite_expires_at: string;
}

export interface HiringAuditEvent {
  id: string;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface HiringAuditEventListResponse {
  items: HiringAuditEvent[];
}

export interface HiringRankingItem {
  rank: number;
  assignment_id: string;
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  candidate_label: string;
  candidate_identity_hidden: boolean;
  status: HiringAssignmentStatus;
  decision: HiringDecision;
  submitted_at: string | null;
  evaluated_at: string | null;
  total_score: number | null;
  average_word_error_rate: number | null;
  transcript_accuracy_percent: number | null;
  reference_item_count: number;
  progress_percent: number;
  validated_count: number;
  rejected_count: number;
  item_count: number;
  time_spent_seconds: number | null;
}

export interface HiringRankingResponse {
  items: HiringRankingItem[];
}

export interface HiringDeepgramReferenceResult {
  assessment_id: string;
  processed_items: number;
  transcribed_items: number;
  skipped_items: number;
  errors: string[];
}

export interface HiringImportResponse {
  imported_items: number;
  skipped_items: number;
  errors: string[];
}

export interface HiringAudioBucket {
  name: string;
  path: string;
  wav_count: number;
}

export interface HiringAudioBucketListResponse {
  root_path: string;
  buckets: HiringAudioBucket[];
}

export interface OrganizationListResponse {
  items: Organization[];
}

export interface OrganizationMemberListResponse {
  items: OrganizationMembership[];
}

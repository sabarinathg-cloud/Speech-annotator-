import type {
  AdminUser,
  AdminMetricsResponse,
  AudioMaskInterval,
  AudioMaskMode,
  ClientSecurityAction,
  ColumnMappingRequest,
  DetectPIIResponse,
  HiringAdminAssignmentReview,
  HiringAudioBucketListResponse,
  HiringAssessmentDetail,
  HiringAssessmentListResponse,
  HiringAssignmentInviteResponse,
  HiringAssignmentListResponse,
  HiringAssignmentSummary,
  HiringAuditEventListResponse,
  HiringCandidateAssignmentDetail,
  HiringDecision,
  HiringImportResponse,
  HiringMetadataField,
  HiringPIIEntry,
  HiringRankingResponse,
  HiringRubricField,
  HiringSubmissionValidationStatus,
  JobStatus,
  PIIAnnotation,
  PIILabel,
  PIILabelCreateRequest,
  PIILabelUpdateRequest,
  Role,
  SecurityAuditEventListResponse,
  SecurityAuditEvent,
  TaskAudioAlignmentResponse,
  TaskDetail,
  TaskListResponse,
  TaskMaskedAudioResponse,
  TaskStatus,
  TokenResponse,
  User,
  UserStatusFilter,
  UploadValidationResult
} from "@outcomes/shared-types";

import { resolveApiBaseUrl } from "@/lib/api-config";
import { clearSession, readSession, writeSession } from "@/lib/session";

function apiUrl(path: string): string {
  return `${resolveApiBaseUrl()}${path}`;
}

export class APIError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string, allowRefresh = true): Promise<T> {
  const { response, payload } = await performRequest(path, init, token);
  if (!response.ok) {
    if (response.status === 401 && token && allowRefresh && path !== "/auth/refresh") {
      const refreshed = await refreshStoredSession();
      if (refreshed) {
        return request<T>(path, init, refreshed.access_token, false);
      }
    }
    const message = extractErrorMessage(payload, response.statusText);
    throw new APIError(message, response.status, payload);
  }
  return payload as T;
}

async function performRequest(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<{ response: Response; payload: unknown }> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(apiUrl(path), { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    return { response, payload };
  }
  return { response, payload };
}

async function requestBlob(
  path: string,
  token: string,
  allowRefresh = true
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await fetch(apiUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && allowRefresh) {
      const refreshed = await refreshStoredSession();
      if (refreshed) {
        return requestBlob(path, refreshed.access_token, false);
      }
    }
    let payload: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    throw new APIError(extractErrorMessage(payload, response.statusText), response.status, payload);
  }
  return {
    blob: await response.blob(),
    filename: filenameFromContentDisposition(response.headers.get("Content-Disposition")),
  };
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const filenameMatch = value.match(/filename="?([^";]+)"?/i);
  return filenameMatch?.[1] ?? null;
}

async function refreshStoredSession(): Promise<TokenResponse | null> {
  const session = readSession();
  if (!session.refreshToken) {
    clearSession();
    return null;
  }

  try {
    const data = await request<TokenResponse>(
      "/auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      },
      undefined,
      false
    );
    writeSession(data.access_token, data.refresh_token, data.user);
    return data;
  } catch {
    clearSession();
    return null;
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail) && detail.length > 0) return "Request validation failed";
  }
  return fallback || "Request failed";
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  return request<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function refreshSession(refreshToken: string): Promise<TokenResponse> {
  return request<TokenResponse>(
    "/auth/refresh",
    { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) },
    undefined,
    false
  );
}

export async function fetchCurrentUser(token: string): Promise<User> {
  return request<User>("/auth/me", { method: "GET" }, token);
}

export async function acknowledgeConfidentiality(token: string): Promise<TokenResponse> {
  return request<TokenResponse>(
    "/auth/confidentiality-acknowledgement",
    { method: "POST" },
    token,
    false
  );
}

export async function fetchTasks(
  token: string,
  params: {
    status?: TaskStatus;
    search?: string;
    assigneeId?: string;
    jobId?: string;
    language?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  }
): Promise<TaskListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.search) query.set("search", params.search);
  if (params.assigneeId) query.set("assignee_id", params.assigneeId);
  if (params.jobId) query.set("job_id", params.jobId);
  if (params.language) query.set("language", params.language);
  if (params.dateFrom) query.set("date_from", params.dateFrom);
  if (params.dateTo) query.set("date_to", params.dateTo);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("page_size", String(params.pageSize));
  return request<TaskListResponse>(`/tasks?${query.toString()}`, { method: "GET" }, token);
}

export async function fetchTask(token: string, taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/tasks/${taskId}`, { method: "GET" }, token);
}

export async function fetchNextTask(token: string): Promise<{ task_id: string | null }> {
  return request<{ task_id: string | null }>("/tasks/next", { method: "GET" }, token);
}

export async function claimTask(token: string, taskId: string): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}/claim`, { method: "POST" }, token);
}

export async function startTask(token: string, taskId: string): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}/start`, { method: "POST" }, token);
}

export async function claimNextTask(token: string): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>("/tasks/next/claim", { method: "POST" }, token);
}

export async function fetchTaskActivity(token: string, taskId: string): Promise<{ items: TaskActivityItem[] }> {
  return request<{ items: TaskActivityItem[] }>(`/tasks/${taskId}/activity`, { method: "GET" }, token);
}

export async function generateTaskAlignment(
  token: string,
  taskId: string,
  force = false
): Promise<TaskAudioAlignmentResponse> {
  const suffix = force ? "?force=true" : "";
  return request<TaskAudioAlignmentResponse>(`/tasks/${taskId}/alignment${suffix}`, { method: "POST" }, token);
}

export async function maskTaskPIIAudio(
  token: string,
  taskId: string,
  force = false,
  maskMode: AudioMaskMode = "silence",
  maskIntervals?: AudioMaskInterval[]
): Promise<TaskMaskedAudioResponse> {
  const params = new URLSearchParams({ mask_mode: maskMode });
  if (force) params.set("force", "true");
  const suffix = `?${params.toString()}`;
  return request<TaskMaskedAudioResponse>(
    `/tasks/${taskId}/mask-pii-audio${suffix}`,
    {
      method: "POST",
      body: maskIntervals ? JSON.stringify({ mask_intervals: maskIntervals }) : undefined,
    },
    token
  );
}

export async function fetchAudioURL(
  token: string,
  taskId: string
): Promise<{ url: string; expires_in_seconds: number }> {
  return request<{ url: string; expires_in_seconds: number }>(
    `/tasks/${taskId}/audio-url`,
    { method: "GET" },
    token
  );
}

export async function patchTranscript(
  token: string,
  taskId: string,
  payload: { version: number; final_transcript: string }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/transcript`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchTaskCombined(
  token: string,
  taskId: string,
  payload: {
    version: number;
    final_transcript?: string | null;
    notes?: string | null;
    status?: TaskStatus | null;
    comment?: string | null;
    speaker_gender?: string | null;
    speaker_role?: string | null;
    language?: string | null;
    channel?: string | null;
    duration_seconds?: number | null;
    due_date?: string | null;
    custom_metadata?: Record<string, unknown> | null;
    pii_annotations?: PIIAnnotation[] | null;
  }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchMetadata(
  token: string,
  taskId: string,
  payload: {
    version: number;
    speaker_gender?: string | null;
    speaker_role?: string | null;
    language?: string | null;
    channel?: string | null;
    duration_seconds?: number | null;
    custom_metadata?: Record<string, unknown>;
  }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/metadata`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchNotes(
  token: string,
  taskId: string,
  payload: { version: number; notes: string | null }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/notes`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchStatus(
  token: string,
  taskId: string,
  payload: { version: number; status: TaskStatus; comment?: string }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/status`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchPII(
  token: string,
  taskId: string,
  payload: { version: number; pii_annotations: PIIAnnotation[] }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/pii`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function detectTaskPII(
  token: string,
  transcript: string,
  includeMl = false,
  timeoutMs = includeMl ? 180_000 : 45_000
): Promise<DetectPIIResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<DetectPIIResponse>(
      "/tasks/detect-pii",
      {
        method: "POST",
        body: JSON.stringify({ transcript, include_ml: includeMl }),
        signal: controller.signal,
      },
      token
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function patchTaskAssignee(
  token: string,
  taskId: string,
  payload: { version: number; assignee_id: string | null }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}/assignee`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function patchTaskDueDate(
  token: string,
  taskId: string,
  payload: { version: number; due_date: string | null }
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(
    `/tasks/${taskId}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function bulkAssignTasks(
  token: string,
  assignments: Array<{ task_id: string; version: number; assignee_id: string | null }>
): Promise<{ updated: Array<{ task: TaskDetail }>; errors: Array<{ task_id: string; status_code: number; message: string }> }> {
  return request(
    "/tasks/bulk-assignee",
    { method: "POST", body: JSON.stringify({ assignments }) },
    token
  );
}

export async function bulkUpdateTaskDueDates(
  token: string,
  updates: Array<{ task_id: string; version: number; due_date: string | null }>
): Promise<{ updated: Array<{ task: TaskDetail }>; errors: Array<{ task_id: string; status_code: number; message: string }> }> {
  return request(
    "/tasks/bulk-due-date",
    { method: "POST", body: JSON.stringify({ updates }) },
    token
  );
}

export async function bulkUpdateTaskStatuses(
  token: string,
  payload: {
    status: TaskStatus;
    updates: Array<{ task_id: string; version: number }>;
    comment?: string | null;
  }
): Promise<{ updated: Array<{ task: TaskDetail }>; errors: Array<{ task_id: string; status_code: number; message: string }> }> {
  return request(
    "/tasks/bulk-status",
    { method: "POST", body: JSON.stringify(payload) },
    token
  );
}

export async function downloadTaskExport(
  token: string,
  params: { format: "csv" | "xlsx"; taskIds?: string[] }
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams();
  query.set("format", params.format);
  params.taskIds?.forEach((taskId) => query.append("task_ids", taskId));
  const response = await requestBlob(`/exports/tasks?${query.toString()}`, token);
  return {
    blob: response.blob,
    filename: response.filename ?? `outcomes_ai_annotations_export.${params.format}`,
  };
}

export async function fetchUsers(
  token: string,
  params: {
    search?: string | null;
    role?: Role | "all" | null;
    status?: UserStatusFilter | null;
  } = {}
): Promise<{ items: AdminUser[] }> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.role && params.role !== "all") query.set("role", params.role);
  if (params.status && params.status !== "all") query.set("status", params.status);
  const suffix = query.toString();
  return request<{ items: AdminUser[] }>(`/users${suffix ? `?${suffix}` : ""}`, { method: "GET" }, token);
}

export async function fetchPIILabels(token: string): Promise<{ items: PIILabel[] }> {
  return request<{ items: PIILabel[] }>("/pii-labels", { method: "GET" }, token);
}

export async function fetchAdminPIILabels(token: string): Promise<{ items: PIILabel[] }> {
  return request<{ items: PIILabel[] }>("/pii-labels/admin", { method: "GET" }, token);
}

export async function createPIILabel(token: string, payload: PIILabelCreateRequest): Promise<PIILabel> {
  return request<PIILabel>("/pii-labels", { method: "POST", body: JSON.stringify(payload) }, token);
}

export async function updatePIILabel(
  token: string,
  labelId: string,
  payload: PIILabelUpdateRequest
): Promise<PIILabel> {
  return request<PIILabel>(`/pii-labels/${labelId}`, { method: "PATCH", body: JSON.stringify(payload) }, token);
}

export async function fetchAdminMetrics(
  token: string,
  params: {
    status?: TaskStatus | "All" | null;
    assigneeId?: string | null;
    jobId?: string | null;
    language?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
  } = {}
): Promise<AdminMetricsResponse> {
  const query = new URLSearchParams();
  if (params.status && params.status !== "All") query.set("status", params.status);
  if (params.assigneeId) query.set("assignee_id", params.assigneeId);
  if (params.jobId) query.set("job_id", params.jobId);
  if (params.language) query.set("language", params.language);
  if (params.dateFrom) query.set("date_from", params.dateFrom);
  if (params.dateTo) query.set("date_to", params.dateTo);
  const suffix = query.toString();
  return request<AdminMetricsResponse>(`/metrics/admin${suffix ? `?${suffix}` : ""}`, { method: "GET" }, token);
}

export async function fetchSecurityAuditEvents(
  token: string,
  params: {
    action?: string | null;
    riskLevel?: string | null;
    actorUserId?: string | null;
    taskId?: string | null;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<SecurityAuditEventListResponse> {
  const query = new URLSearchParams();
  if (params.action) query.set("action", params.action);
  if (params.riskLevel) query.set("risk_level", params.riskLevel);
  if (params.actorUserId) query.set("actor_user_id", params.actorUserId);
  if (params.taskId) query.set("task_id", params.taskId);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("page_size", String(params.pageSize));
  const suffix = query.toString();
  return request<SecurityAuditEventListResponse>(
    `/security/audit-events${suffix ? `?${suffix}` : ""}`,
    { method: "GET" },
    token
  );
}

export async function logClientSecurityEvent(
  token: string,
  payload: { action: ClientSecurityAction; metadata?: Record<string, unknown> }
): Promise<SecurityAuditEvent> {
  return request<SecurityAuditEvent>(
    "/security/client-events",
    { method: "POST", body: JSON.stringify({ action: payload.action, metadata: payload.metadata ?? {} }) },
    token,
    false
  );
}

export async function fetchHiringAssessments(token: string): Promise<HiringAssessmentListResponse> {
  return request<HiringAssessmentListResponse>("/hiring/assessments", { method: "GET" }, token);
}

export async function createHiringAssessment(
  token: string,
  payload: {
    title: string;
    instructions?: string;
    due_date?: string | null;
    due_at?: string | null;
    time_limit_minutes?: number | null;
    blind_review_enabled?: boolean;
    metadata_schema?: HiringMetadataField[];
    pii_label_keys?: string[];
    rubric_schema?: HiringRubricField[];
  }
): Promise<HiringAssessmentDetail> {
  return request<HiringAssessmentDetail>(
    "/hiring/assessments",
    { method: "POST", body: JSON.stringify(payload) },
    token
  );
}

export async function updateHiringAssessment(
  token: string,
  assessmentId: string,
  payload: {
    title?: string;
    instructions?: string;
    status?: "DRAFT" | "ACTIVE" | "CLOSED";
    due_date?: string | null;
    due_at?: string | null;
    time_limit_minutes?: number | null;
    blind_review_enabled?: boolean;
    metadata_schema?: HiringMetadataField[];
    pii_label_keys?: string[];
    rubric_schema?: HiringRubricField[];
  }
): Promise<HiringAssessmentDetail> {
  return request<HiringAssessmentDetail>(
    `/hiring/assessments/${assessmentId}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function fetchHiringAssessment(token: string, assessmentId: string): Promise<HiringAssessmentDetail> {
  return request<HiringAssessmentDetail>(`/hiring/assessments/${assessmentId}`, { method: "GET" }, token);
}

export async function updateHiringItemReference(
  token: string,
  assessmentId: string,
  itemId: string,
  payload: {
    reference_transcript?: string | null;
    reference_pii_entries?: HiringPIIEntry[];
    reference_metadata?: Record<string, unknown> | null;
  }
): Promise<HiringAssessmentDetail> {
  return request<HiringAssessmentDetail>(
    `/hiring/assessments/${assessmentId}/items/${itemId}/reference`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function uploadHiringAudio(
  token: string,
  assessmentId: string,
  files: File[]
): Promise<HiringImportResponse> {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  return request<HiringImportResponse>(
    `/hiring/assessments/${assessmentId}/items/upload`,
    { method: "POST", body: formData },
    token
  );
}

export async function importHiringFolder(
  token: string,
  assessmentId: string,
  payload: { folder_path: string; recursive: boolean }
): Promise<HiringImportResponse> {
  return request<HiringImportResponse>(
    `/hiring/assessments/${assessmentId}/items/folder`,
    { method: "POST", body: JSON.stringify(payload) },
    token
  );
}

export async function fetchHiringAudioBuckets(
  token: string,
  payload: { root_path: string; recursive: boolean }
): Promise<HiringAudioBucketListResponse> {
  return request<HiringAudioBucketListResponse>(
    "/hiring/audio-buckets",
    { method: "POST", body: JSON.stringify(payload) },
    token
  );
}

export async function importHiringAssignmentFolder(
  token: string,
  assignmentId: string,
  payload: { folder_path: string; recursive: boolean }
): Promise<HiringImportResponse> {
  return request<HiringImportResponse>(
    `/hiring/assignments/${assignmentId}/items/folder`,
    { method: "POST", body: JSON.stringify(payload) },
    token
  );
}

export async function importHiringManifest(
  token: string,
  assessmentId: string,
  file: File
): Promise<HiringImportResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return request<HiringImportResponse>(
    `/hiring/assessments/${assessmentId}/items/manifest`,
    { method: "POST", body: formData },
    token
  );
}

export async function assignHiringCandidates(
  token: string,
  assessmentId: string,
  candidateIds: string[]
): Promise<HiringAssignmentListResponse> {
  return request<HiringAssignmentListResponse>(
    `/hiring/assessments/${assessmentId}/assignments`,
    { method: "POST", body: JSON.stringify({ candidate_ids: candidateIds }) },
    token
  );
}

export async function fetchHiringAssessmentAssignments(
  token: string,
  assessmentId: string
): Promise<HiringAssignmentListResponse> {
  return request<HiringAssignmentListResponse>(
    `/hiring/assessments/${assessmentId}/assignments`,
    { method: "GET" },
    token
  );
}

export async function fetchHiringAssessmentRanking(
  token: string,
  assessmentId: string
): Promise<HiringRankingResponse> {
  return request<HiringRankingResponse>(
    `/hiring/assessments/${assessmentId}/ranking`,
    { method: "GET" },
    token
  );
}

export async function createHiringAssignmentInvite(
  token: string,
  assignmentId: string
): Promise<HiringAssignmentInviteResponse> {
  return request<HiringAssignmentInviteResponse>(
    `/hiring/assignments/${assignmentId}/invite`,
    { method: "POST" },
    token
  );
}

export async function fetchHiringAssignmentReview(
  token: string,
  assignmentId: string
): Promise<HiringAdminAssignmentReview> {
  return request<HiringAdminAssignmentReview>(
    `/hiring/assignments/${assignmentId}/review`,
    { method: "GET" },
    token
  );
}

export async function updateHiringAssignmentAccess(
  token: string,
  assignmentId: string,
  payload: { access_revoked: boolean }
): Promise<HiringAssignmentSummary> {
  return request<HiringAssignmentSummary>(
    `/hiring/assignments/${assignmentId}/access`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function clearHiringAssignmentAudio(
  token: string,
  assignmentId: string
): Promise<HiringAssignmentSummary> {
  return request<HiringAssignmentSummary>(
    `/hiring/assignments/${assignmentId}/items`,
    { method: "DELETE" },
    token
  );
}

export async function deleteHiringAssignment(
  token: string,
  assignmentId: string
): Promise<{ deleted_assignment_id: string }> {
  return request<{ deleted_assignment_id: string }>(
    `/hiring/assignments/${assignmentId}`,
    { method: "DELETE" },
    token
  );
}

export async function fetchHiringAssignmentAuditEvents(
  token: string,
  assignmentId: string
): Promise<HiringAuditEventListResponse> {
  return request<HiringAuditEventListResponse>(
    `/hiring/assignments/${assignmentId}/audit-events`,
    { method: "GET" },
    token
  );
}

export async function updateHiringSubmissionValidation(
  token: string,
  submissionId: string,
  payload: { validation_status: HiringSubmissionValidationStatus; validation_feedback?: string | null }
): Promise<unknown> {
  return request(
    `/hiring/submissions/${submissionId}/validation`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function updateHiringScorecard(
  token: string,
  assignmentId: string,
  payload: {
    transcript_score?: number | null;
    pii_score?: number | null;
    metadata_score?: number | null;
    total_score?: number | null;
    rubric_scores?: Record<string, number | null>;
    decision: HiringDecision;
    evaluator_notes?: string | null;
  }
): Promise<HiringAdminAssignmentReview> {
  return request<HiringAdminAssignmentReview>(
    `/hiring/assignments/${assignmentId}/scorecard`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function fetchCandidateHiringAssignments(token: string): Promise<HiringAssignmentListResponse> {
  return request<HiringAssignmentListResponse>("/hiring/candidate/assignments", { method: "GET" }, token);
}

export async function fetchCandidateHiringAssignment(
  token: string,
  assignmentId: string
): Promise<HiringCandidateAssignmentDetail> {
  return request<HiringCandidateAssignmentDetail>(
    `/hiring/candidate/assignments/${assignmentId}`,
    { method: "GET" },
    token
  );
}

export async function patchCandidateHiringSubmission(
  token: string,
  submissionId: string,
  payload: {
    version: number;
    final_transcript?: string;
    pii_annotations?: PIIAnnotation[];
    pii_text?: string;
    pii_entries?: HiringPIIEntry[];
    metadata_values?: Record<string, unknown>;
    notes?: string;
    pii_reviewed?: boolean;
  }
): Promise<HiringCandidateAssignmentDetail> {
  return request<HiringCandidateAssignmentDetail>(
    `/hiring/candidate/submissions/${submissionId}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token
  );
}

export async function submitCandidateHiringAssignment(
  token: string,
  assignmentId: string
): Promise<HiringCandidateAssignmentDetail> {
  return request<HiringCandidateAssignmentDetail>(
    `/hiring/candidate/assignments/${assignmentId}/submit`,
    { method: "POST" },
    token
  );
}

export async function detectCandidatePII(
  token: string,
  transcript: string,
  includeMl = false
): Promise<DetectPIIResponse> {
  return request<DetectPIIResponse>(
    "/hiring/candidate/detect-pii",
    { method: "POST", body: JSON.stringify({ transcript, include_ml: includeMl }) },
    token
  );
}

export async function downloadCandidateHiringAudio(
  token: string,
  assignmentId: string,
  itemId: string
): Promise<{ blob: Blob; filename: string }> {
  const response = await requestBlob(
    `/hiring/candidate/assignments/${assignmentId}/items/${itemId}/download`,
    token
  );
  return { blob: response.blob, filename: response.filename ?? "hiring-audio.wav" };
}

export async function downloadCandidateHiringZip(
  token: string,
  assignmentId: string
): Promise<{ blob: Blob; filename: string }> {
  const response = await requestBlob(`/hiring/candidate/assignments/${assignmentId}/download-zip`, token);
  return { blob: response.blob, filename: response.filename ?? "hiring-audio.zip" };
}

export async function createUser(
  token: string,
  payload: {
    email: string;
    full_name: string;
    role: Role;
    password: string;
    is_active?: boolean;
  }
): Promise<AdminUser> {
  return request<AdminUser>("/users", { method: "POST", body: JSON.stringify(payload) }, token);
}

export async function updateUser(
  token: string,
  userId: string,
  payload: {
    full_name?: string;
    role?: Role;
    password?: string;
    is_active?: boolean;
  }
): Promise<AdminUser> {
  return request<AdminUser>(`/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }, token);
}

export async function deleteUser(token: string, userId: string): Promise<AdminUser> {
  return request<AdminUser>(`/users/${userId}`, { method: "DELETE" }, token);
}

export async function resetUserPassword(token: string, userId: string, password: string): Promise<AdminUser> {
  return request<AdminUser>(
    `/users/${userId}/reset-password`,
    { method: "POST", body: JSON.stringify({ password }) },
    token
  );
}

export async function uploadExcel(
  token: string,
  file: File
): Promise<{ id: string; upload_job_id: string; filename: string; status: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return request<{ id: string; upload_job_id: string; filename: string; status: string }>(
    "/uploads",
    { method: "POST", body: formData },
    token
  );
}

export async function previewUpload(
  token: string,
  uploadJobId: string
): Promise<{ upload_job_id: string; columns: string[]; sample_rows: Record<string, unknown>[]; row_count: number }> {
  return request(`/uploads/${uploadJobId}/preview`, { method: "GET" }, token);
}

export async function validateUpload(
  token: string,
  uploadJobId: string,
  mapping: ColumnMappingRequest
): Promise<UploadValidationResult> {
  return request<UploadValidationResult>(
    `/uploads/${uploadJobId}/validate`,
    { method: "POST", body: JSON.stringify(mapping) },
    token
  );
}

export async function importUpload(
  token: string,
  uploadJobId: string,
  mapping: ColumnMappingRequest
): Promise<{ upload_job_id: string; imported_tasks: number; skipped_rows: number; status: string }> {
  return request(`/uploads/${uploadJobId}/import`, { method: "POST", body: JSON.stringify(mapping) }, token);
}

export async function enqueueImportJob(
  token: string,
  uploadJobId: string,
  mapping: ColumnMappingRequest
): Promise<{ job_id: string; status: string }> {
  return request(`/uploads/${uploadJobId}/import/jobs`, { method: "POST", body: JSON.stringify(mapping) }, token);
}

export async function enqueueExportJob(
  token: string,
  payload: {
    format: "csv" | "xlsx";
    status?: TaskStatus | null;
    assignee_id?: string | null;
    job_id?: string | null;
    language?: string | null;
    date_from?: string | null;
    date_to?: string | null;
  }
): Promise<{ job_id: string; status: string }> {
  return request("/exports/tasks/jobs", { method: "POST", body: JSON.stringify(payload) }, token);
}

export async function fetchJob(token: string, jobId: string): Promise<JobStatus> {
  return request<JobStatus>(`/jobs/${jobId}`, { method: "GET" }, token);
}

export function jobDownloadUrl(jobId: string): string {
  return apiUrl(`/jobs/${jobId}/download`);
}

export async function downloadJobOutput(token: string, jobId: string): Promise<Blob> {
  const response = await fetch(jobDownloadUrl(jobId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new APIError(response.statusText || "Download failed", response.status, text);
  }
  return response.blob();
}

export interface TaskActivityItem {
  id: string;
  type: "audit" | "status" | string;
  action: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  changed_at: string;
  changed_fields: Record<string, unknown>;
  previous_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  old_status: TaskStatus | null;
  new_status: TaskStatus | null;
  comment: string | null;
}

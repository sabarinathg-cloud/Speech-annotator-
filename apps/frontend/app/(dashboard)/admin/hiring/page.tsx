"use client";

import type {
  AdminUser,
  HiringAdminAssignmentReview,
  HiringAudioBucket,
  HiringAssignmentInviteResponse,
  HiringAuditEvent,
  HiringAssessmentDetail,
  HiringAssignmentSummary,
  HiringDecision,
  HiringMetadataField,
  HiringPIIEntry,
  HiringRankingItem,
  HiringRubricField,
  HiringSubmission,
  HiringSubmissionValidationStatus,
} from "@outcomes/shared-types";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  assignHiringCandidates,
  clearHiringAssignmentAudio,
  createHiringAssignmentInvite,
  createUser,
  createHiringAssessment,
  deleteHiringAssessment,
  deleteHiringAssignment,
  deleteUser,
  fetchHiringAssignmentAuditEvents,
  fetchHiringAssessment,
  fetchHiringAssessmentAssignments,
  fetchHiringAssignmentReview,
  fetchHiringAssessmentRanking,
  fetchHiringAssessments,
  fetchHiringAudioBuckets,
  fetchUsers,
  importHiringAssignmentFolder,
  importHiringFolder,
  importHiringManifest,
  updateHiringAssessment,
  updateHiringAssignmentAccess,
  updateHiringItemReference,
  updateHiringScorecard,
  updateHiringSubmissionValidation,
  updateUser,
  uploadHiringAudio,
} from "@/lib/api";
import { defaultHiringInstructions } from "@/lib/hiring-instructions";

const emptyField: HiringMetadataField = {
  key: "",
  label: "",
  type: "text",
  required: false,
  options: [],
  sort_order: 0,
};

const emptyRubricField: HiringRubricField = {
  key: "",
  label: "",
  max_score: 10,
  required: true,
  sort_order: 0,
};

const emptyReferencePIIEntry: HiringPIIEntry = {
  type: "",
  value: "",
  timestamp: null,
  notes: null,
};

type ReferenceDraft = {
  reference_transcript: string;
  reference_pii_entries: HiringPIIEntry[];
};

type AssignmentFolderDraft = {
  folder_path: string;
  recursive: boolean;
};

type AdminHiringTab = "setup" | "audio" | "candidates" | "review";

function defaultMetadataFields(): HiringMetadataField[] {
  return [
    {
      key: "audio_quality",
      label: "Audio quality",
      type: "select",
      required: true,
      options: ["Clean audio", "Background noise", "Background speaker", "Overlapping speech", "Low volume"],
      sort_order: 0,
    },
  ];
}

function defaultRubricFields(): HiringRubricField[] {
  return [
    { key: "transcript_accuracy", label: "Transcript accuracy", max_score: 40, required: true, sort_order: 0 },
    { key: "pii_identification", label: "PII identification", max_score: 30, required: true, sort_order: 1 },
    { key: "metadata_quality", label: "Metadata quality", max_score: 20, required: true, sort_order: 2 },
    { key: "instructions", label: "Following instructions", max_score: 10, required: true, sort_order: 3 },
  ];
}

function formatDate(value: string | null) {
  if (!value) return "No due date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function formatDateTime(value: string | null) {
  if (!value) return "Not submitted";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function formatDeadline(dueAt: string | null, dueDate: string | null) {
  if (dueAt) return formatDateTime(dueAt);
  return formatDate(dueDate);
}

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function datetimeLocalToIso(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function formatDuration(totalSeconds: number | null) {
  if (totalSeconds === null) return "--";
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes} min`;
}

function formatWer(value: number | null | undefined) {
  if (value === null || value === undefined) return "No reference";
  return `${Math.round(value * 1000) / 10}% WER`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  return `${Math.round(value * 10) / 10}%`;
}

function formatSuggestion(submission: HiringSubmission) {
  const metrics = submission.reference_metrics;
  if (
    !metrics ||
    metrics.suggested_transcript_score === null ||
    metrics.suggested_transcript_score === undefined ||
    metrics.suggested_transcript_score_max === null ||
    metrics.suggested_transcript_score_max === undefined
  ) return "No suggestion";
  return `${metrics.suggested_transcript_score}/${metrics.suggested_transcript_score_max}`;
}

function numericInputValue(value: number | null) {
  return value === null ? "" : String(value);
}

function displayAnswerValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "--";
  if (Array.isArray(value)) return value.map(displayAnswerValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function piiEntryLabel(entry: HiringPIIEntry): string {
  const details = [entry.timestamp ? `Time ${entry.timestamp}` : null, entry.notes].filter(Boolean).join(" | ");
  return `${entry.type}: ${entry.value}${details ? ` (${details})` : ""}`;
}

function findTranscriptRubricKey(fields: HiringRubricField[]): string | null {
  const field = fields.find((candidate) => {
    const haystack = `${candidate.key} ${candidate.label}`.toLowerCase();
    return haystack.includes("transcript") || haystack.includes("accuracy");
  });
  return field?.key ?? null;
}

export default function AdminHiringPage() {
  const { accessToken } = useAuth();
  const [assessments, setAssessments] = useState<Awaited<ReturnType<typeof fetchHiringAssessments>>["items"]>([]);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HiringAssessmentDetail | null>(null);
  const [assignments, setAssignments] = useState<HiringAssignmentSummary[]>([]);
  const [review, setReview] = useState<HiringAdminAssignmentReview | null>(null);
  const [candidates, setCandidates] = useState<AdminUser[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState(defaultHiringInstructions);
  const [dueAt, setDueAt] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState("");
  const [blindReviewEnabled, setBlindReviewEnabled] = useState(false);
  const [metadataFields, setMetadataFields] = useState<HiringMetadataField[]>(defaultMetadataFields);
  const [rubricFields, setRubricFields] = useState<HiringRubricField[]>(defaultRubricFields);
  const [settingsDueAt, setSettingsDueAt] = useState("");
  const [settingsTimeLimitMinutes, setSettingsTimeLimitMinutes] = useState("");
  const [settingsInstructions, setSettingsInstructions] = useState("");
  const [settingsBlindReviewEnabled, setSettingsBlindReviewEnabled] = useState(false);
  const [settingsRubricFields, setSettingsRubricFields] = useState<HiringRubricField[]>(defaultRubricFields);
  const [folderPath, setFolderPath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [bucketRootPath, setBucketRootPath] = useState("");
  const [bucketScanRecursive, setBucketScanRecursive] = useState(false);
  const [audioBuckets, setAudioBuckets] = useState<HiringAudioBucket[]>([]);
  const [assignmentFolderDrafts, setAssignmentFolderDrafts] = useState<Record<string, AssignmentFolderDraft>>({});
  const [audioFiles, setAudioFiles] = useState<File[]>([]);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [newCandidateName, setNewCandidateName] = useState("");
  const [newCandidateEmail, setNewCandidateEmail] = useState("");
  const [newCandidatePassword, setNewCandidatePassword] = useState("");
  const [ranking, setRanking] = useState<HiringRankingItem[]>([]);
  const [inviteCredential, setInviteCredential] = useState<HiringAssignmentInviteResponse | null>(null);
  const [auditEvents, setAuditEvents] = useState<HiringAuditEvent[]>([]);
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, ReferenceDraft>>({});
  const [activeTab, setActiveTab] = useState<AdminHiringTab>("candidates");
  const [answerViewerOpen, setAnswerViewerOpen] = useState(false);
  const [answerSearch, setAnswerSearch] = useState("");
  const [selectedAnswerSubmissionId, setSelectedAnswerSubmissionId] = useState<string | null>(null);
  const [referenceSearch, setReferenceSearch] = useState("");
  const [selectedReferenceItemId, setSelectedReferenceItemId] = useState<string | null>(null);
  const [scoreDraft, setScoreDraft] = useState({
    transcript_score: "",
    pii_score: "",
    metadata_score: "",
    total_score: "",
    rubric_scores: {} as Record<string, string>,
    decision: "PENDING" as HiringDecision,
    evaluator_notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deferredAnswerSearch = useDeferredValue(answerSearch);
  const deferredReferenceSearch = useDeferredValue(referenceSearch);

  useEffect(() => {
    if (!accessToken) return;
    void refreshAll();
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !selectedAssessmentId) {
      setDetail(null);
      setAssignments([]);
      setRanking([]);
      return;
    }
    void loadAssessment(selectedAssessmentId);
  }, [accessToken, selectedAssessmentId]);

  useEffect(() => {
    if (!detail) return;
    setSettingsInstructions(detail.instructions);
    setSettingsDueAt(toDatetimeLocal(detail.due_at));
    setSettingsTimeLimitMinutes(detail.time_limit_minutes ? String(detail.time_limit_minutes) : "");
    setSettingsBlindReviewEnabled(detail.blind_review_enabled);
    setSettingsRubricFields(detail.rubric_schema.length > 0 ? detail.rubric_schema : defaultRubricFields());
  }, [detail?.id, detail?.instructions, detail?.due_at, detail?.time_limit_minutes, detail?.blind_review_enabled, detail?.rubric_schema]);

  useEffect(() => {
    if (!detail) {
      setReferenceDrafts({});
      setSelectedReferenceItemId(null);
      return;
    }
    setReferenceDrafts(
      Object.fromEntries(
        detail.items.map((item) => [
          item.id,
          {
            reference_transcript: item.reference_transcript ?? "",
            reference_pii_entries: item.reference_pii_entries.length > 0 ? item.reference_pii_entries : [],
          },
        ])
      )
    );
    setSelectedReferenceItemId((current) =>
      current && detail.items.some((item) => item.id === current) ? current : detail.items[0]?.id ?? null
    );
  }, [detail]);

  const assignmentStats = useMemo(() => {
    const submitted = assignments.filter((assignment) => assignment.status === "SUBMITTED").length;
    const evaluated = assignments.filter((assignment) => assignment.status === "EVALUATED").length;
    const revoked = assignments.filter((assignment) => assignment.access_revoked).length;
    const inProgress = assignments.filter((assignment) => assignment.status === "IN_PROGRESS").length;
    return { submitted, evaluated, revoked, inProgress };
  }, [assignments]);

  const referenceNeedle = deferredReferenceSearch.trim().toLowerCase();
  const filteredReferenceItems = useMemo(
    () =>
      (detail?.items ?? []).filter((item) => {
        if (!referenceNeedle) return true;
        return `${item.original_filename} ${item.original_source ?? ""}`.toLowerCase().includes(referenceNeedle);
      }),
    [detail?.items, referenceNeedle]
  );
  const selectedReferenceItem = useMemo(
    () =>
      (detail?.items ?? []).find((item) => item.id === selectedReferenceItemId) ??
      filteredReferenceItems[0] ??
      detail?.items[0] ??
      null,
    [detail?.items, filteredReferenceItems, selectedReferenceItemId]
  );
  const selectedReferenceDraft = selectedReferenceItem
    ? referenceDrafts[selectedReferenceItem.id] ?? { reference_transcript: "", reference_pii_entries: [] }
    : null;
  const referenceAnswerCount = useMemo(
    () =>
      (detail?.items ?? []).filter((item) => Boolean(item.reference_transcript) || item.reference_pii_entries.length > 0)
        .length,
    [detail?.items]
  );
  const reviewItemsById = useMemo(
    () => new Map((review?.items ?? []).map((item) => [item.id, item])),
    [review?.items]
  );
  const answerNeedle = deferredAnswerSearch.trim().toLowerCase();
  const filteredAnswerSubmissions = useMemo(
    () =>
      (review?.submissions ?? []).filter((submission) => {
        if (!answerNeedle) return true;
        const item = reviewItemsById.get(submission.item_id);
        return `${item?.original_filename ?? ""} ${submission.final_transcript} ${submission.pii_text}`
          .toLowerCase()
          .includes(answerNeedle);
      }),
    [answerNeedle, review?.submissions, reviewItemsById]
  );
  const selectedAnswerSubmission = useMemo(
    () =>
      (review?.submissions ?? []).find((submission) => submission.id === selectedAnswerSubmissionId) ??
      filteredAnswerSubmissions[0] ??
      review?.submissions[0] ??
      null,
    [filteredAnswerSubmissions, review?.submissions, selectedAnswerSubmissionId]
  );
  const selectedAnswerItem = selectedAnswerSubmission ? reviewItemsById.get(selectedAnswerSubmission.item_id) ?? null : null;

  useEffect(() => {
    if (!review) {
      setAnswerViewerOpen(false);
      setSelectedAnswerSubmissionId(null);
      return;
    }
    setSelectedAnswerSubmissionId((current) =>
      current && review.submissions.some((submission) => submission.id === current)
        ? current
        : review.submissions[0]?.id ?? null
    );
  }, [review]);

  const cleanedMetadataFields = useMemo(
    () =>
      metadataFields
        .filter((field) => field.key.trim() && field.label.trim())
        .map((field, index) => ({
          ...field,
          key: field.key.trim(),
          label: field.label.trim(),
          options: field.type === "select" ? field.options.filter(Boolean) : [],
          sort_order: index,
        })),
    [metadataFields]
  );

  const cleanedRubricFields = useMemo(
    () =>
      rubricFields
        .filter((field) => field.key.trim() && field.label.trim())
        .map((field, index) => ({
          ...field,
          key: field.key.trim(),
          label: field.label.trim(),
          max_score: Number(field.max_score) || 1,
          sort_order: index,
        })),
    [rubricFields]
  );

  const cleanedSettingsRubricFields = useMemo(
    () =>
      settingsRubricFields
        .filter((field) => field.key.trim() && field.label.trim())
        .map((field, index) => ({
          ...field,
          key: field.key.trim(),
          label: field.label.trim(),
          max_score: Number(field.max_score) || 1,
          sort_order: index,
        })),
    [settingsRubricFields]
  );

  const suggestedTranscriptScore = useMemo(() => {
    if (!review) return null;
    const suggestions = review.submissions
      .map((submission) => submission.reference_metrics?.suggested_transcript_score)
      .filter((value): value is number => value !== null && value !== undefined);
    if (suggestions.length === 0) return null;
    return Math.round((suggestions.reduce((total, value) => total + value, 0) / suggestions.length) * 100) / 100;
  }, [review]);

  async function refreshAll(preferredAssessmentId: string | null = selectedAssessmentId) {
    if (!accessToken) return;
    try {
      const [assessmentResponse, userResponse] = await Promise.all([
        fetchHiringAssessments(accessToken),
        fetchUsers(accessToken, { role: "CANDIDATE", status: "all" }),
      ]);
      setAssessments(assessmentResponse.items);
      setCandidates(userResponse.items);
      const preferredStillExists = assessmentResponse.items.some((assessment) => assessment.id === preferredAssessmentId);
      const nextSelectedAssessmentId = preferredStillExists
        ? preferredAssessmentId
        : assessmentResponse.items[0]?.id ?? null;
      setSelectedAssessmentId(nextSelectedAssessmentId);
      if (!nextSelectedAssessmentId) {
        setDetail(null);
        setAssignments([]);
        setRanking([]);
        setReview(null);
        setAuditEvents([]);
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not load hiring data");
    }
  }

  async function loadAssessment(assessmentId: string) {
    if (!accessToken) return;
    try {
      const [assessment, assignmentResponse, rankingResponse] = await Promise.all([
        fetchHiringAssessment(accessToken, assessmentId),
        fetchHiringAssessmentAssignments(accessToken, assessmentId),
        fetchHiringAssessmentRanking(accessToken, assessmentId),
      ]);
      setDetail(assessment);
      setAssignments(assignmentResponse.items);
      setRanking(rankingResponse.items);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not load assessment");
    }
  }

  async function createAssessment() {
    if (!accessToken || !title.trim()) return;
    setBusy(true);
    try {
      const created = await createHiringAssessment(accessToken, {
        title,
        instructions: instructions.trim(),
        due_date: dueAt ? dueAt.slice(0, 10) : null,
        due_at: datetimeLocalToIso(dueAt),
        time_limit_minutes: timeLimitMinutes ? Number(timeLimitMinutes) : null,
        blind_review_enabled: blindReviewEnabled,
        metadata_schema: cleanedMetadataFields,
        rubric_schema: cleanedRubricFields,
      });
      setTitle("");
      setInstructions(defaultHiringInstructions);
      setDueAt("");
      setTimeLimitMinutes("");
      setBlindReviewEnabled(false);
      setMetadataFields(defaultMetadataFields());
      setRubricFields(defaultRubricFields());
      setSelectedAssessmentId(created.id);
      setMessage("Assessment created");
      await refreshAll(created.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeAssessment(assessment: Awaited<ReturnType<typeof fetchHiringAssessments>>["items"][number]) {
    if (!accessToken) return;
    const confirmation = window.prompt(
      `Type "${assessment.title}" to delete this assessment. This removes its audio, candidate assignments, and submissions.`
    );
    if (confirmation === null) return;
    if (confirmation !== assessment.title) {
      setError("Assessment title did not match. Delete cancelled.");
      return;
    }
    const remainingAssessments = assessments.filter((item) => item.id !== assessment.id);
    const nextSelectedAssessmentId =
      selectedAssessmentId === assessment.id ? remainingAssessments[0]?.id ?? null : selectedAssessmentId;
    setBusy(true);
    try {
      const result = await deleteHiringAssessment(accessToken, assessment.id);
      if (selectedAssessmentId === assessment.id) {
        setDetail(null);
        setAssignments([]);
        setRanking([]);
        setReview(null);
        setAuditEvents([]);
      }
      setSelectedAssessmentId(nextSelectedAssessmentId);
      await refreshAll(nextSelectedAssessmentId);
      setMessage(
        `Deleted ${assessment.title} with ${result.deleted_items} audio item${result.deleted_items === 1 ? "" : "s"} and ${result.deleted_assignments} candidate assignment${result.deleted_assignments === 1 ? "" : "s"}.`
      );
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not delete assessment");
    } finally {
      setBusy(false);
    }
  }

  async function setAssessmentStatus(status: "DRAFT" | "ACTIVE" | "CLOSED") {
    if (!accessToken || !detail) return;
    setBusy(true);
    try {
      const updated = await updateHiringAssessment(accessToken, detail.id, { status });
      setDetail(updated);
      await refreshAll();
      setMessage(`Assessment set to ${status}`);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveAssessmentSettings() {
    if (!accessToken || !detail) return;
    setBusy(true);
    try {
      const updated = await updateHiringAssessment(accessToken, detail.id, {
        due_date: settingsDueAt ? settingsDueAt.slice(0, 10) : null,
        due_at: datetimeLocalToIso(settingsDueAt),
        instructions: settingsInstructions.trim(),
        time_limit_minutes: settingsTimeLimitMinutes ? Number(settingsTimeLimitMinutes) : null,
        blind_review_enabled: settingsBlindReviewEnabled,
        rubric_schema: cleanedSettingsRubricFields,
      });
      setDetail(updated);
      await loadAssessment(detail.id);
      setMessage("Assessment settings saved");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Settings save failed");
    } finally {
      setBusy(false);
    }
  }

  async function importFolder() {
    if (!accessToken || !detail || !folderPath.trim()) return;
    setBusy(true);
    try {
      const result = await importHiringFolder(accessToken, detail.id, { folder_path: folderPath.trim(), recursive });
      setMessage(`Imported ${result.imported_items} WAV file${result.imported_items === 1 ? "" : "s"}`);
      setError(result.errors[0] ?? null);
      await loadAssessment(detail.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Folder import failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadAudioBuckets() {
    if (!accessToken || !bucketRootPath.trim()) return;
    setBusy(true);
    try {
      const response = await fetchHiringAudioBuckets(accessToken, {
        root_path: bucketRootPath.trim(),
        recursive: bucketScanRecursive,
      });
      setBucketRootPath(response.root_path);
      setAudioBuckets(response.buckets);
      setMessage(`Loaded ${response.buckets.length} bucket${response.buckets.length === 1 ? "" : "s"}`);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Bucket load failed");
    } finally {
      setBusy(false);
    }
  }

  function updateAssignmentFolderDraft(assignmentId: string, patch: Partial<AssignmentFolderDraft>) {
    setAssignmentFolderDrafts((current) => ({
      ...current,
      [assignmentId]: {
        ...(current[assignmentId] ?? { folder_path: "", recursive: false }),
        ...patch,
      },
    }));
  }

  async function importAssignmentFolder(assignmentId: string) {
    if (!accessToken || !detail) return;
    const draft = assignmentFolderDrafts[assignmentId];
    if (!draft?.folder_path.trim()) return;
    setBusy(true);
    try {
      const result = await importHiringAssignmentFolder(accessToken, assignmentId, {
        folder_path: draft.folder_path.trim(),
        recursive: draft.recursive,
      });
      setAssignmentFolderDrafts((current) => ({
        ...current,
        [assignmentId]: { folder_path: "", recursive: draft.recursive },
      }));
      setMessage(`Imported ${result.imported_items} candidate WAV file${result.imported_items === 1 ? "" : "s"}`);
      setError(result.errors[0] ?? null);
      await loadAssessment(detail.id);
      if (review?.id === assignmentId) {
        await openReview(assignmentId);
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Candidate folder import failed");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAudio() {
    if (!accessToken || !detail || audioFiles.length === 0) return;
    setBusy(true);
    try {
      const result = await uploadHiringAudio(accessToken, detail.id, audioFiles);
      setMessage(`Imported ${result.imported_items} file${result.imported_items === 1 ? "" : "s"}`);
      setError(result.errors[0] ?? null);
      setAudioFiles([]);
      await loadAssessment(detail.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function importManifest() {
    if (!accessToken || !detail || !manifestFile) return;
    setBusy(true);
    try {
      const result = await importHiringManifest(accessToken, detail.id, manifestFile);
      setMessage(`Imported ${result.imported_items} manifest row${result.imported_items === 1 ? "" : "s"}`);
      setError(result.errors[0] ?? null);
      setManifestFile(null);
      await loadAssessment(detail.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Manifest import failed");
    } finally {
      setBusy(false);
    }
  }

  function updateReferenceDraft(itemId: string, update: Partial<ReferenceDraft>) {
    setReferenceDrafts((prev) => ({
      ...prev,
      [itemId]: {
        reference_transcript: prev[itemId]?.reference_transcript ?? "",
        reference_pii_entries: prev[itemId]?.reference_pii_entries ?? [],
        ...update,
      },
    }));
  }

  function updateReferencePiiEntry(itemId: string, index: number, update: Partial<HiringPIIEntry>) {
    setReferenceDrafts((prev) => {
      const current = prev[itemId] ?? { reference_transcript: "", reference_pii_entries: [] };
      return {
        ...prev,
        [itemId]: {
          ...current,
          reference_pii_entries: current.reference_pii_entries.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, ...update } : entry
          ),
        },
      };
    });
  }

  function addReferencePiiEntry(itemId: string) {
    const current = referenceDrafts[itemId] ?? { reference_transcript: "", reference_pii_entries: [] };
    updateReferenceDraft(itemId, {
      reference_pii_entries: [
        ...current.reference_pii_entries,
        { ...emptyReferencePIIEntry },
      ],
    });
  }

  function removeReferencePiiEntry(itemId: string, index: number) {
    const current = referenceDrafts[itemId] ?? { reference_transcript: "", reference_pii_entries: [] };
    updateReferenceDraft(itemId, {
      reference_pii_entries: current.reference_pii_entries.filter((_, entryIndex) => entryIndex !== index),
    });
  }

  async function saveItemReference(itemId: string) {
    if (!accessToken || !detail) return;
    const draft = referenceDrafts[itemId] ?? { reference_transcript: "", reference_pii_entries: [] };
    const referencePiiEntries = draft.reference_pii_entries
      .map((entry) => ({
        type: entry.type.trim(),
        value: entry.value.trim(),
        timestamp: entry.timestamp?.trim() || null,
        notes: entry.notes?.trim() || null,
      }))
      .filter((entry) => entry.type && entry.value);
    setBusy(true);
    try {
      const updated = await updateHiringItemReference(accessToken, detail.id, itemId, {
        reference_transcript: draft.reference_transcript.trim() || null,
        reference_pii_entries: referencePiiEntries,
      });
      setDetail(updated);
      if (review) await openReview(review.id);
      setMessage("Reference answer saved");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Reference save failed");
    } finally {
      setBusy(false);
    }
  }

  async function assignCandidates() {
    if (!accessToken || !detail || selectedCandidateIds.length === 0) return;
    setBusy(true);
    try {
      const response = await assignHiringCandidates(accessToken, detail.id, selectedCandidateIds);
      setAssignments(response.items);
      setSelectedCandidateIds([]);
      setMessage("Candidates assigned");
      await loadAssessment(detail.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  async function generateInvite(assignmentId: string) {
    if (!accessToken) return;
    setBusy(true);
    try {
      const response = await createHiringAssignmentInvite(accessToken, assignmentId);
      setInviteCredential(response);
      if (detail) await loadAssessment(detail.id);
      setMessage("Invite credentials generated");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Invite generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function createCandidate() {
    if (!accessToken || !newCandidateName.trim() || !newCandidateEmail.trim() || newCandidatePassword.length < 8) return;
    setBusy(true);
    try {
      const created = await createUser(accessToken, {
        full_name: newCandidateName.trim(),
        email: newCandidateEmail.trim(),
        password: newCandidatePassword,
        role: "CANDIDATE",
        is_active: true,
      });
      setNewCandidateName("");
      setNewCandidateEmail("");
      setNewCandidatePassword("");
      setSelectedCandidateIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      setMessage(`Candidate ${created.full_name} onboarded`);
      setError(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Candidate onboarding failed");
    } finally {
      setBusy(false);
    }
  }

  async function setCandidateActive(candidate: AdminUser, active: boolean) {
    if (!accessToken) return;
    setBusy(true);
    try {
      if (active) {
        await updateUser(accessToken, candidate.id, { is_active: true });
      } else {
        await deleteUser(accessToken, candidate.id);
      }
      setSelectedCandidateIds((prev) => active ? prev : prev.filter((id) => id !== candidate.id));
      await refreshAll();
      if (detail) await loadAssessment(detail.id);
      setMessage(active ? "Candidate restored" : "Candidate removed");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Candidate update failed");
    } finally {
      setBusy(false);
    }
  }

  async function setAssignmentAccess(assignment: HiringAssignmentSummary, accessRevoked: boolean) {
    if (!accessToken || !detail) return;
    setBusy(true);
    try {
      await updateHiringAssignmentAccess(accessToken, assignment.id, { access_revoked: accessRevoked });
      await loadAssessment(detail.id);
      if (review?.id === assignment.id) await openReview(assignment.id);
      setMessage(accessRevoked ? "Access revoked" : "Access restored");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Access update failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearAssignmentAudio(assignment: HiringAssignmentSummary) {
    if (!accessToken || !detail) return;
    if (!window.confirm(`Clear candidate-specific audio for ${assignment.candidate_name}? Shared assessment audio will stay.`)) return;
    setBusy(true);
    try {
      await clearHiringAssignmentAudio(accessToken, assignment.id);
      setAssignmentFolderDrafts((current) => ({
        ...current,
        [assignment.id]: current[assignment.id] ?? { folder_path: "", recursive: false },
      }));
      await loadAssessment(detail.id);
      if (review?.id === assignment.id) await openReview(assignment.id);
      setMessage("Candidate audio cleared. You can import a new bucket now.");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not clear candidate audio");
    } finally {
      setBusy(false);
    }
  }

  async function removeAssignment(assignment: HiringAssignmentSummary) {
    if (!accessToken || !detail) return;
    if (!window.confirm(`Remove assignment for ${assignment.candidate_name}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteHiringAssignment(accessToken, assignment.id);
      setAssignmentFolderDrafts((current) => {
        const next = { ...current };
        delete next[assignment.id];
        return next;
      });
      if (review?.id === assignment.id) {
        setReview(null);
        setAuditEvents([]);
      }
      await loadAssessment(detail.id);
      setMessage("Assignment removed");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not remove assignment");
    } finally {
      setBusy(false);
    }
  }

  function applySuggestedTranscriptScore(score: number | null = suggestedTranscriptScore) {
    if (score === null) return;
    const value = String(score);
    const transcriptRubricKey = detail ? findTranscriptRubricKey(detail.rubric_schema) : null;
    setScoreDraft((prev) => ({
      ...prev,
      transcript_score: value,
      rubric_scores: transcriptRubricKey
        ? { ...prev.rubric_scores, [transcriptRubricKey]: value }
        : prev.rubric_scores,
    }));
  }

  async function openReview(
    assignmentId: string,
    options: { openAnswers?: boolean; switchToReviewTab?: boolean } = {}
  ) {
    if (!accessToken) return;
    try {
      const [response, auditResponse] = await Promise.all([
        fetchHiringAssignmentReview(accessToken, assignmentId),
        fetchHiringAssignmentAuditEvents(accessToken, assignmentId),
      ]);
      setReview(response);
      setScoreDraft({
        transcript_score: numericInputValue(response.transcript_score),
        pii_score: numericInputValue(response.pii_score),
        metadata_score: numericInputValue(response.metadata_score),
        total_score: numericInputValue(response.total_score),
        rubric_scores: Object.fromEntries(
          Object.entries(response.rubric_scores ?? {}).map(([key, value]) => [key, value === null ? "" : String(value)])
        ),
        decision: response.decision,
        evaluator_notes: response.evaluator_notes ?? "",
      });
      setAuditEvents(auditResponse.items);
      if (options.openAnswers) {
        setAnswerSearch("");
        setSelectedAnswerSubmissionId(response.submissions[0]?.id ?? null);
        setAnswerViewerOpen(true);
      }
      if (options.switchToReviewTab ?? true) {
        setActiveTab("review");
      }
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not load review");
    }
  }

  async function openCandidateAnswers(assignmentId: string) {
    await openReview(assignmentId, { openAnswers: true, switchToReviewTab: false });
  }

  async function validateSubmission(submissionId: string, validation_status: HiringSubmissionValidationStatus) {
    if (!accessToken || !review) return;
    setBusy(true);
    try {
      await updateHiringSubmissionValidation(accessToken, submissionId, { validation_status });
      await openReview(review.id);
      if (detail) await loadAssessment(detail.id);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Validation update failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveScorecard() {
    if (!accessToken || !review) return;
    setBusy(true);
    try {
      const updated = await updateHiringScorecard(accessToken, review.id, {
        transcript_score: scoreDraft.transcript_score ? Number(scoreDraft.transcript_score) : null,
        pii_score: scoreDraft.pii_score ? Number(scoreDraft.pii_score) : null,
        metadata_score: scoreDraft.metadata_score ? Number(scoreDraft.metadata_score) : null,
        total_score: scoreDraft.total_score ? Number(scoreDraft.total_score) : null,
        rubric_scores: Object.fromEntries(
          Object.entries(scoreDraft.rubric_scores)
            .filter(([, value]) => value !== "")
            .map(([key, value]) => [key, Number(value)])
        ),
        decision: scoreDraft.decision,
        evaluator_notes: scoreDraft.evaluator_notes || null,
      });
      setReview(updated);
      if (detail) await loadAssessment(detail.id);
      setMessage("Scorecard saved");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Scorecard save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">Admin</p>
        <h1 className="oa-title text-2xl font-semibold">Hiring assessments</h1>
      </section>

      {error ? <p className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">{error}</p> : null}
      {message ? <p className="rounded-lg border border-[#c8e6d4] bg-[#f0fbf4] px-3 py-2 text-sm text-[#236140]">{message}</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:max-h-[calc(100vh-132px)] xl:overflow-y-auto xl:pr-1">
          <section className="oa-card p-4">
            <h2 className="oa-title text-lg font-semibold">Create assessment</h2>
            <div className="mt-3 space-y-3">
              <input className="oa-input" placeholder="Assessment title" value={title} onChange={(event) => setTitle(event.target.value)} />
              <label className="block text-sm">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[#332d53]">Candidate instructions</span>
                  <button type="button" className="oa-btn-quiet px-2 py-1 text-xs" onClick={() => setInstructions(defaultHiringInstructions)}>
                    Use default
                  </button>
                </span>
                <textarea className="oa-textarea mt-1 min-h-[180px]" placeholder="Candidate instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-[#332d53]">Submission deadline</span>
                <input className="oa-input mt-1" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
              </label>
              <input className="oa-input" type="number" min="1" placeholder="Time limit in minutes" value={timeLimitMinutes} onChange={(event) => setTimeLimitMinutes(event.target.value)} />
              <label className="flex items-center gap-2 text-sm text-[#5f5b79]">
                <input type="checkbox" checked={blindReviewEnabled} onChange={(event) => setBlindReviewEnabled(event.target.checked)} />
                Blind review mode
              </label>
              <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[#332d53]">Metadata fields</p>
                  <button type="button" className="oa-btn-quiet px-2.5 py-1 text-xs" onClick={() => setMetadataFields((prev) => [...prev, { ...emptyField, sort_order: prev.length }])}>
                    Add
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {metadataFields.map((field, index) => (
                    <div key={index} className="rounded-lg border border-[#ece5f6] bg-white p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <input className="oa-input" placeholder="key" value={field.key} onChange={(event) => setMetadataFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
                        <input className="oa-input" placeholder="label" value={field.label} onChange={(event) => setMetadataFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} />
                        <select className="oa-select" value={field.type} onChange={(event) => setMetadataFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as HiringMetadataField["type"] } : item))}>
                          <option value="text">Text</option>
                          <option value="number">Number</option>
                          <option value="date">Date</option>
                          <option value="select">Select</option>
                        </select>
                        <label className="flex items-center gap-2 text-sm text-[#5f5b79]">
                          <input type="checkbox" checked={field.required} onChange={(event) => setMetadataFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />
                          Required
                        </label>
                      </div>
                      {field.type === "select" ? (
                        <input className="oa-input mt-2" placeholder="Options, comma separated" value={field.options.join(", ")} onChange={(event) => setMetadataFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, options: event.target.value.split(",").map((option) => option.trim()).filter(Boolean) } : item))} />
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[#332d53]">Rubric fields</p>
                  <button type="button" className="oa-btn-quiet px-2.5 py-1 text-xs" onClick={() => setRubricFields((prev) => [...prev, { ...emptyRubricField, sort_order: prev.length }])}>
                    Add
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {rubricFields.map((field, index) => (
                    <div key={index} className="rounded-lg border border-[#ece5f6] bg-white p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <input className="oa-input" placeholder="key" value={field.key} onChange={(event) => setRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
                        <input className="oa-input" placeholder="label" value={field.label} onChange={(event) => setRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} />
                        <input className="oa-input" type="number" min="1" placeholder="max score" value={field.max_score} onChange={(event) => setRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, max_score: Number(event.target.value) } : item))} />
                        <label className="flex items-center gap-2 text-sm text-[#5f5b79]">
                          <input type="checkbox" checked={field.required} onChange={(event) => setRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />
                          Required
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <button type="button" onClick={createAssessment} disabled={busy || !title.trim()} className="oa-btn-primary w-full px-4 py-2 text-sm font-semibold disabled:opacity-50">
                Create
              </button>
            </div>
          </section>

          <section className="oa-card p-4">
            <h2 className="oa-title text-lg font-semibold">Assessments</h2>
            <div className="mt-3 space-y-2">
              {assessments.map((assessment) => (
                <div
                  key={assessment.id}
                  className={`flex items-center gap-2 rounded-xl border p-2 text-sm ${selectedAssessmentId === assessment.id ? "border-[#b99bde] bg-white" : "border-[#eee5f8] bg-[#fbf8ff]"}`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedAssessmentId(assessment.id)}
                    className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left transition hover:bg-white"
                  >
                    <span className="block truncate font-semibold text-[#1f1b3f]">{assessment.title}</span>
                    <span className="mt-1 block text-xs text-[#6b7280]">{assessment.status} | {assessment.item_count} audio | {assessment.assignment_count} candidates</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeAssessment(assessment)}
                    disabled={busy}
                    className="oa-btn-secondary shrink-0 px-2.5 py-1.5 text-xs disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              ))}
              {assessments.length === 0 ? <p className="text-sm text-[#5f5b79]">No assessments yet.</p> : null}
            </div>
          </section>
        </aside>

        <main className="space-y-4">
          {detail ? (
            <>
              <section className="oa-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="oa-title text-xl font-semibold">{detail.title}</h2>
                    <p className="mt-1 text-sm text-[#5f5b79]">
                      {detail.status} | Due {formatDeadline(detail.due_at, detail.due_date)} | {detail.item_count} audio files | {detail.time_limit_minutes ? `${detail.time_limit_minutes} min limit` : "No timer"} | {detail.blind_review_enabled ? "Blind review on" : "Blind review off"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void setAssessmentStatus("ACTIVE")} disabled={busy || detail.status === "ACTIVE"} className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50">Activate</button>
                    <button type="button" onClick={() => void setAssessmentStatus("CLOSED")} disabled={busy || detail.status === "CLOSED"} className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50">Close</button>
                  </div>
                </div>
              </section>

              <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <AdminMetric label="Audio" value={String(detail.item_count)} />
                <AdminMetric label="Candidates" value={String(assignments.length)} />
                <AdminMetric label="Submitted" value={String(assignmentStats.submitted)} />
                <AdminMetric label="Need review" value={String(Math.max(assignmentStats.submitted - assignmentStats.evaluated, 0))} />
              </section>

              <nav className="oa-card flex flex-wrap gap-2 p-2" aria-label="Hiring admin sections">
                <AdminTabButton active={activeTab === "candidates"} onClick={() => setActiveTab("candidates")}>
                  Candidates
                </AdminTabButton>
                <AdminTabButton active={activeTab === "review"} onClick={() => setActiveTab("review")}>
                  Review
                </AdminTabButton>
                <AdminTabButton active={activeTab === "audio"} onClick={() => setActiveTab("audio")}>
                  Audio & References
                </AdminTabButton>
                <AdminTabButton active={activeTab === "setup"} onClick={() => setActiveTab("setup")}>
                  Setup
                </AdminTabButton>
              </nav>

              {activeTab === "setup" ? (
                <>
              <section className="oa-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="oa-title text-base font-semibold">Assessment settings</h3>
                  <button type="button" onClick={saveAssessmentSettings} disabled={busy} className="oa-btn-primary px-3 py-2 text-sm font-semibold disabled:opacity-50">
                    Save Settings
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(280px,360px)_1fr]">
                  <div className="space-y-3">
                    <label className="block text-sm">
                      <span className="font-medium text-[#332d53]">Submission deadline</span>
                      <input className="oa-input mt-1" type="datetime-local" value={settingsDueAt} onChange={(event) => setSettingsDueAt(event.target.value)} />
                    </label>
                    <input className="oa-input" type="number" min="1" placeholder="Time limit minutes" value={settingsTimeLimitMinutes} onChange={(event) => setSettingsTimeLimitMinutes(event.target.value)} />
                    <label className="flex items-center gap-2 text-sm text-[#5f5b79]">
                      <input type="checkbox" checked={settingsBlindReviewEnabled} onChange={(event) => setSettingsBlindReviewEnabled(event.target.checked)} />
                      Blind review mode
                    </label>
                    <label className="block text-sm">
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#332d53]">Candidate instructions</span>
                        <button type="button" className="oa-btn-quiet px-2 py-1 text-xs" onClick={() => setSettingsInstructions(defaultHiringInstructions)}>
                          Use default
                        </button>
                      </span>
                      <textarea
                        className="oa-textarea mt-1 min-h-[220px]"
                        placeholder="Candidate instructions"
                        value={settingsInstructions}
                        onChange={(event) => setSettingsInstructions(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-[#332d53]">Rubric fields</p>
                      <button type="button" className="oa-btn-quiet px-2.5 py-1 text-xs" onClick={() => setSettingsRubricFields((prev) => [...prev, { ...emptyRubricField, sort_order: prev.length }])}>
                        Add
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      {settingsRubricFields.map((field, index) => (
                        <div key={index} className="rounded-lg border border-[#ece5f6] bg-white p-2">
                          <div className="grid grid-cols-2 gap-2">
                            <input className="oa-input" placeholder="key" value={field.key} onChange={(event) => setSettingsRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
                            <input className="oa-input" placeholder="label" value={field.label} onChange={(event) => setSettingsRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} />
                            <input className="oa-input" type="number" min="1" placeholder="max score" value={field.max_score} onChange={(event) => setSettingsRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, max_score: Number(event.target.value) } : item))} />
                            <label className="flex items-center gap-2 text-sm text-[#5f5b79]">
                              <input type="checkbox" checked={field.required} onChange={(event) => setSettingsRubricFields((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />
                              Required
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Upload WAV/ZIP</h3>
                  <input className="mt-3 block w-full text-sm" type="file" multiple accept=".wav,.zip" onChange={(event) => setAudioFiles(Array.from(event.target.files ?? []))} />
                  <button type="button" onClick={uploadAudio} disabled={busy || audioFiles.length === 0} className="oa-btn-secondary mt-3 px-3 py-2 text-sm disabled:opacity-50">Import Upload</button>
                </div>
                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Mounted Folder</h3>
                  <input className="oa-input mt-3" placeholder="/mnt/hiring-audio" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} />
                  <label className="mt-2 flex items-center gap-2 text-sm text-[#5f5b79]">
                    <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                    Recursive scan
                  </label>
                  <button type="button" onClick={importFolder} disabled={busy || !folderPath.trim()} className="oa-btn-secondary mt-3 px-3 py-2 text-sm disabled:opacity-50">Import Folder</button>
                </div>
                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Excel Manifest</h3>
                  <input className="mt-3 block w-full text-sm" type="file" accept=".xlsx,.xls" onChange={(event) => setManifestFile(event.target.files?.[0] ?? null)} />
                  <button type="button" onClick={importManifest} disabled={busy || !manifestFile} className="oa-btn-secondary mt-3 px-3 py-2 text-sm disabled:opacity-50">Import Manifest</button>
                </div>
              </section>
                </>
              ) : null}

              {activeTab === "audio" ? (
                <section className="oa-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="oa-title text-base font-semibold">Audio & reference answers</h3>
                      <p className="mt-1 text-xs text-[#6b7280]">
                        {referenceAnswerCount}/{detail.items.length} files have a reference answer
                      </p>
                    </div>
                    {selectedReferenceItem ? (
                      <button
                        type="button"
                        onClick={() => void saveItemReference(selectedReferenceItem.id)}
                        disabled={busy}
                        className="oa-btn-primary px-3 py-2 text-sm font-semibold disabled:opacity-50"
                      >
                        Save Reference
                      </button>
                    ) : null}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                    <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                      <input
                        className="oa-input h-9 text-sm"
                        placeholder="Search audio"
                        value={referenceSearch}
                        onChange={(event) => setReferenceSearch(event.target.value)}
                      />
                      <div className="mt-3 max-h-[540px] space-y-1 overflow-y-auto pr-1">
                        {filteredReferenceItems.slice(0, 300).map((item) => {
                          const hasReference = Boolean(item.reference_transcript) || item.reference_pii_entries.length > 0;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedReferenceItemId(item.id)}
                              className={`w-full rounded-lg border px-2 py-2 text-left text-xs transition ${
                                selectedReferenceItem?.id === item.id
                                  ? "border-[#b99bde] bg-white shadow-sm"
                                  : "border-[#eee5f8] bg-[#fffafe] hover:bg-white"
                              }`}
                            >
                              <span className="block truncate font-semibold text-[#1f1b3f]" title={item.original_filename}>
                                {item.original_filename}
                              </span>
                              <span className="mt-1 flex items-center justify-between gap-2">
                                <span className="text-[#7a7395]">{item.assignment_id ? "Candidate-specific" : "Shared"}</span>
                                <span className={hasReference ? "text-[#236140]" : "text-[#8a5b1e]"}>
                                  {hasReference ? "Reference set" : "No reference"}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        {filteredReferenceItems.length > 300 ? (
                          <p className="rounded-lg border border-[#eee5f8] bg-white px-2 py-2 text-xs text-[#6b7280]">
                            Showing first 300. Search to narrow the list.
                          </p>
                        ) : null}
                        {filteredReferenceItems.length === 0 ? (
                          <p className="rounded-lg border border-[#eee5f8] bg-white px-2 py-2 text-xs text-[#6b7280]">No audio matches this search.</p>
                        ) : null}
                      </div>
                    </div>

                    {selectedReferenceItem && selectedReferenceDraft ? (
                      <article className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate font-semibold text-[#1f1b3f]" title={selectedReferenceItem.original_filename}>
                                {selectedReferenceItem.original_filename}
                              </p>
                              <span className="rounded-full border border-[#ddd5ef] bg-white px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-[#6c5f90]">
                                {selectedReferenceItem.assignment_id ? "Candidate" : "Shared"}
                              </span>
                            </div>
                            <p className="mt-1 break-all text-xs text-[#6b7280]">{selectedReferenceItem.original_source}</p>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
                          <label className="block text-sm">
                            <span className="font-medium text-[#332d53]">Reference transcript</span>
                            <textarea
                              className="oa-textarea mt-1 min-h-[280px]"
                              value={selectedReferenceDraft.reference_transcript}
                              onChange={(event) =>
                                updateReferenceDraft(selectedReferenceItem.id, { reference_transcript: event.target.value })
                              }
                            />
                          </label>
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-[#332d53]">Expected PII</p>
                              <button
                                type="button"
                                className="oa-btn-quiet px-2.5 py-1 text-xs"
                                onClick={() => addReferencePiiEntry(selectedReferenceItem.id)}
                              >
                                Add
                              </button>
                            </div>
                            <div className="mt-2 max-h-[420px] space-y-2 overflow-y-auto pr-1">
                              {selectedReferenceDraft.reference_pii_entries.map((entry, index) => (
                                <div key={`${selectedReferenceItem.id}-reference-pii-${index}`} className="rounded-lg border border-[#e5dbf1] bg-white p-2">
                                  <div className="grid grid-cols-2 gap-2">
                                    <input
                                      className="oa-input h-9"
                                      placeholder="Type"
                                      value={entry.type}
                                      onChange={(event) =>
                                        updateReferencePiiEntry(selectedReferenceItem.id, index, { type: event.target.value })
                                      }
                                    />
                                    <input
                                      className="oa-input h-9"
                                      placeholder="Value"
                                      value={entry.value}
                                      onChange={(event) =>
                                        updateReferencePiiEntry(selectedReferenceItem.id, index, { value: event.target.value })
                                      }
                                    />
                                    <input
                                      className="oa-input h-9"
                                      placeholder="Timestamp"
                                      value={entry.timestamp ?? ""}
                                      onChange={(event) =>
                                        updateReferencePiiEntry(selectedReferenceItem.id, index, { timestamp: event.target.value || null })
                                      }
                                    />
                                    <input
                                      className="oa-input h-9"
                                      placeholder="Notes"
                                      value={entry.notes ?? ""}
                                      onChange={(event) =>
                                        updateReferencePiiEntry(selectedReferenceItem.id, index, { notes: event.target.value || null })
                                      }
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    className="oa-btn-quiet mt-2 px-2.5 py-1 text-xs"
                                    onClick={() => removeReferencePiiEntry(selectedReferenceItem.id, index)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                              {selectedReferenceDraft.reference_pii_entries.length === 0 ? (
                                <p className="rounded-lg border border-[#e5dbf1] bg-white px-3 py-2 text-xs text-[#7a7395]">No expected PII rows</p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </article>
                    ) : (
                      <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-6 text-sm text-[#5f5b79]">
                        Import audio to add reference answers.
                      </div>
                    )}
                  </div>
                </section>
              ) : null}

              {activeTab === "candidates" ? (
                <>
              <section className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Assign candidates</h3>
                  <div className="mt-3 rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-3">
                    <p className="text-sm font-semibold text-[#332d53]">Onboard candidate</p>
                    <div className="mt-3 space-y-2">
                      <input
                        className="oa-input"
                        placeholder="Full name"
                        value={newCandidateName}
                        onChange={(event) => setNewCandidateName(event.target.value)}
                      />
                      <input
                        className="oa-input"
                        type="email"
                        placeholder="Email"
                        value={newCandidateEmail}
                        onChange={(event) => setNewCandidateEmail(event.target.value)}
                      />
                      <input
                        className="oa-input"
                        type="password"
                        placeholder="Temporary password"
                        value={newCandidatePassword}
                        onChange={(event) => setNewCandidatePassword(event.target.value)}
                      />
                      <button
                        type="button"
                        onClick={createCandidate}
                        disabled={busy || !newCandidateName.trim() || !newCandidateEmail.trim() || newCandidatePassword.length < 8}
                        className="oa-btn-secondary w-full px-3 py-2 text-sm font-semibold disabled:opacity-50"
                      >
                        Create Candidate
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 max-h-[300px] space-y-2 overflow-auto">
                    {candidates.map((candidate) => (
                      <div key={candidate.id} className="rounded-lg border border-[#eee5f8] bg-[#fbf8ff] px-3 py-2 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={!candidate.is_active}
                            checked={selectedCandidateIds.includes(candidate.id)}
                            onChange={(event) =>
                              setSelectedCandidateIds((prev) =>
                                event.target.checked ? [...prev, candidate.id] : prev.filter((id) => id !== candidate.id)
                              )
                            }
                          />
                          <span>{candidate.full_name}</span>
                          <span className="ml-auto text-xs text-[#7a7395]">{candidate.is_active ? "Active" : "Removed"}</span>
                        </label>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-[#7a7395]">{candidate.email}</span>
                          {candidate.is_active ? (
                            <button type="button" className="oa-btn-quiet px-2 py-1 text-xs" onClick={() => void setCandidateActive(candidate, false)}>
                              Remove User
                            </button>
                          ) : (
                            <button type="button" className="oa-btn-quiet px-2 py-1 text-xs" onClick={() => void setCandidateActive(candidate, true)}>
                              Restore User
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={assignCandidates} disabled={busy || selectedCandidateIds.length === 0} className="oa-btn-primary mt-3 w-full px-4 py-2 text-sm font-semibold disabled:opacity-50">
                    Assign Selected
                  </button>
                  {inviteCredential ? (
                    <div className="mt-3 rounded-xl border border-[#c8e6d4] bg-[#f0fbf4] p-3 text-xs text-[#236140]">
                      <p className="font-semibold">Latest invite</p>
                      <p className="mt-1 break-all">Link: {inviteCredential.invite_url}</p>
                      <p className="mt-1">Username: {inviteCredential.candidate_email}</p>
                      <p className="mt-1">Password: {inviteCredential.temporary_password}</p>
                      <p className="mt-1">Expires: {formatDateTime(inviteCredential.invite_expires_at)}</p>
                    </div>
                  ) : null}
                </div>

                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Candidate progress</h3>
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[#eee5f8] bg-[#fbf8ff] p-3 lg:grid-cols-[minmax(260px,1fr)_auto_auto]">
                    <input
                      className="oa-input h-10 text-sm"
                      placeholder="/mnt/amc-data/vad_triage_4_buckets_balanced_by_call_id"
                      value={bucketRootPath}
                      onChange={(event) => setBucketRootPath(event.target.value)}
                    />
                    <label className="flex items-center gap-2 text-xs text-[#5f5b79]">
                      <input
                        type="checkbox"
                        checked={bucketScanRecursive}
                        onChange={(event) => setBucketScanRecursive(event.target.checked)}
                      />
                      Recursive count
                    </label>
                    <button
                      type="button"
                      onClick={() => void loadAudioBuckets()}
                      disabled={busy || !bucketRootPath.trim()}
                      className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50"
                    >
                      Load Buckets
                    </button>
                  </div>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[1320px] text-left text-sm">
                      <thead className="text-xs uppercase tracking-[0.12em] text-[#7a7395]">
                        <tr>
                          <th className="py-2">Candidate</th>
                          <th className="py-2">Status</th>
                          <th className="py-2">Access</th>
                          <th className="py-2">Progress</th>
                          <th className="py-2">Candidate Folder</th>
                          <th className="py-2">Time Left</th>
                          <th className="py-2">Submitted</th>
                          <th className="py-2">Last Save</th>
                          <th className="py-2">Score</th>
                          <th className="py-2">Invite</th>
                          <th className="py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {assignments.map((assignment) => {
                          const folderDraft = assignmentFolderDrafts[assignment.id] ?? { folder_path: "", recursive: false };
                          const canImportCandidateAudio = !["SUBMITTED", "EVALUATED"].includes(assignment.status);
                          const canModifyAssignment = !["SUBMITTED", "EVALUATED"].includes(assignment.status);
                          return (
                            <tr key={assignment.id} className="border-t border-[#eee5f8]">
                              <td className="py-2 pr-3">
                                <p className="font-medium text-[#1f1b3f]">{assignment.candidate_name}</p>
                                <p className="text-xs text-[#7a7395]">{assignment.candidate_email}</p>
                              </td>
                              <td className="py-2 pr-3">{assignment.status}</td>
                              <td className="py-2 pr-3">{assignment.access_revoked ? "Revoked" : "Open"}</td>
                              <td className="py-2 pr-3">{assignment.submitted_count}/{assignment.item_count}</td>
                              <td className="py-2 pr-3">
                                <div className="flex min-w-[260px] max-w-[320px] flex-col gap-2">
                                  {audioBuckets.length > 0 ? (
                                    <select
                                      className="oa-input h-9 text-xs"
                                      value={folderDraft.folder_path}
                                      onChange={(event) =>
                                        updateAssignmentFolderDraft(assignment.id, { folder_path: event.target.value })
                                      }
                                      disabled={!canImportCandidateAudio}
                                    >
                                      <option value="">Select bucket</option>
                                      {audioBuckets.map((bucket) => (
                                        <option key={bucket.path} value={bucket.path}>
                                          {bucket.name} ({bucket.wav_count})
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                  <input
                                    className="oa-input h-9 text-xs"
                                    placeholder="/mnt/hiring-audio/candidate"
                                    value={folderDraft.folder_path}
                                    onChange={(event) => updateAssignmentFolderDraft(assignment.id, { folder_path: event.target.value })}
                                    disabled={!canImportCandidateAudio}
                                  />
                                  <div className="flex items-center justify-between gap-2">
                                    <label className="flex items-center gap-2 text-xs text-[#5f5b79]">
                                      <input
                                        type="checkbox"
                                        checked={folderDraft.recursive}
                                        onChange={(event) => updateAssignmentFolderDraft(assignment.id, { recursive: event.target.checked })}
                                        disabled={!canImportCandidateAudio}
                                      />
                                      Recursive
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => void importAssignmentFolder(assignment.id)}
                                      disabled={busy || !canImportCandidateAudio || !folderDraft.folder_path.trim()}
                                      className="oa-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
                                    >
                                      Import
                                    </button>
                                  </div>
                                </div>
                              </td>
                              <td className="py-2 pr-3">{formatDuration(assignment.seconds_remaining)}</td>
                              <td className="py-2 pr-3">{formatDateTime(assignment.submitted_at)}</td>
                              <td className="py-2 pr-3">{formatDateTime(assignment.last_saved_at)}</td>
                              <td className="py-2 pr-3">{assignment.total_score ?? "--"} | {assignment.decision}</td>
                              <td className="py-2 pr-3">
                                <button type="button" onClick={() => void generateInvite(assignment.id)} disabled={assignment.access_revoked} className="oa-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">Invite</button>
                              </td>
                              <td className="py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => void setAssignmentAccess(assignment, !assignment.access_revoked)}
                                  className="oa-btn-secondary mr-2 px-3 py-1.5 text-xs"
                                >
                                  {assignment.access_revoked ? "Restore" : "Revoke"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void clearAssignmentAudio(assignment)}
                                  disabled={busy || !canModifyAssignment}
                                  className="oa-btn-secondary mr-2 px-3 py-1.5 text-xs disabled:opacity-50"
                                >
                                  Clear Audio
                                </button>
                                <button type="button" onClick={() => void openCandidateAnswers(assignment.id)} className="oa-btn-secondary mr-2 px-3 py-1.5 text-xs">Answers</button>
                                <button
                                  type="button"
                                  onClick={() => void removeAssignment(assignment)}
                                  disabled={busy || !canModifyAssignment}
                                  className="oa-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>

              <section className="oa-card p-4">
                <h3 className="oa-title text-base font-semibold">Candidate ranking</h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="text-xs uppercase tracking-[0.12em] text-[#7a7395]">
                      <tr>
                        <th className="py-2">Rank</th>
                        <th className="py-2">Candidate</th>
                        <th className="py-2">Score</th>
                        <th className="py-2">Progress</th>
                        <th className="py-2">Decision</th>
                        <th className="py-2">Time Spent</th>
                        <th className="py-2">Submitted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranking.map((item) => (
                        <tr key={item.assignment_id} className="border-t border-[#eee5f8]">
                          <td className="py-2 pr-3 font-semibold text-[#1f1b3f]">#{item.rank}</td>
                          <td className="py-2 pr-3">
                            <p className="font-medium text-[#1f1b3f]">{item.candidate_name}</p>
                            <p className="text-xs text-[#7a7395]">{item.candidate_email}</p>
                          </td>
                          <td className="py-2 pr-3">{item.total_score ?? "--"}</td>
                          <td className="py-2 pr-3">{item.progress_percent}%</td>
                          <td className="py-2 pr-3">{item.decision}</td>
                          <td className="py-2 pr-3">{item.time_spent_seconds === null ? "--" : `${Math.round(item.time_spent_seconds / 60)} min`}</td>
                          <td className="py-2 pr-3">{formatDateTime(item.submitted_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {ranking.length === 0 ? <p className="mt-3 text-sm text-[#5f5b79]">No candidates assigned yet.</p> : null}
                </div>
              </section>
                </>
              ) : null}

              {activeTab === "review" && review ? (
                <section className="oa-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="oa-title text-lg font-semibold">Review: {review.candidate_name}</h3>
                      <p className="text-sm text-[#5f5b79]">
                        {review.candidate_email} | {review.status} | Submitted {formatDateTime(review.submitted_at)}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      <input className="oa-input" type="number" placeholder="Transcript" value={scoreDraft.transcript_score} onChange={(event) => setScoreDraft((prev) => ({ ...prev, transcript_score: event.target.value }))} />
                      <input className="oa-input" type="number" placeholder="PII" value={scoreDraft.pii_score} onChange={(event) => setScoreDraft((prev) => ({ ...prev, pii_score: event.target.value }))} />
                      <input className="oa-input" type="number" placeholder="Metadata" value={scoreDraft.metadata_score} onChange={(event) => setScoreDraft((prev) => ({ ...prev, metadata_score: event.target.value }))} />
                      <input className="oa-input" type="number" placeholder="Total" value={scoreDraft.total_score} onChange={(event) => setScoreDraft((prev) => ({ ...prev, total_score: event.target.value }))} />
                      <select className="oa-select" value={scoreDraft.decision} onChange={(event) => setScoreDraft((prev) => ({ ...prev, decision: event.target.value as HiringDecision }))}>
                        <option value="PENDING">Pending</option>
                        <option value="PASS">Pass</option>
                        <option value="FAIL">Fail</option>
                        <option value="HOLD">Hold</option>
                      </select>
                    </div>
                  </div>
                  <textarea className="oa-textarea mt-3 min-h-[80px]" placeholder="Evaluator notes" value={scoreDraft.evaluator_notes} onChange={(event) => setScoreDraft((prev) => ({ ...prev, evaluator_notes: event.target.value }))} />
                  {suggestedTranscriptScore !== null ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#d9ebdc] bg-[#f0fbf4] px-3 py-2 text-sm text-[#236140]">
                      <span className="font-semibold">Suggested transcript score: {suggestedTranscriptScore}</span>
                      <button
                        type="button"
                        className="oa-btn-secondary px-3 py-1.5 text-xs"
                        onClick={() => applySuggestedTranscriptScore()}
                      >
                        Use Suggestion
                      </button>
                    </div>
                  ) : null}
                  {detail.rubric_schema.length > 0 ? (
                    <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
                      {detail.rubric_schema.map((field) => (
                        <label key={field.key} className="block text-sm">
                          <span className="font-medium text-[#332d53]">{field.label} / {field.max_score}</span>
                          <input
                            className="oa-input mt-1"
                            type="number"
                            min="0"
                            max={field.max_score}
                            value={scoreDraft.rubric_scores[field.key] ?? ""}
                            onChange={(event) => setScoreDraft((prev) => ({
                              ...prev,
                              rubric_scores: { ...prev.rubric_scores, [field.key]: event.target.value },
                            }))}
                          />
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <button type="button" onClick={saveScorecard} disabled={busy} className="oa-btn-primary mt-3 px-4 py-2 text-sm font-semibold disabled:opacity-50">Save Scorecard</button>

                  <div className="mt-5 space-y-4">
                    {review.submissions.map((submission) => {
                      const item = reviewItemsById.get(submission.item_id);
                      const metrics = submission.reference_metrics;
                      const itemSuggestedTranscriptScore = metrics?.suggested_transcript_score;
                      return (
                        <article key={submission.id} className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h4 className="font-semibold text-[#1f1b3f]">{item?.original_filename ?? submission.item_id}</h4>
                              <p className="text-xs text-[#7a7395]">
                                {formatWer(metrics?.word_error_rate)} | Accuracy {formatPercent(metrics?.transcript_accuracy_percent)} | Suggested {formatSuggestion(submission)}
                              </p>
                              <p className="text-xs text-[#7a7395]">Submitted {formatDateTime(submission.submitted_at)}</p>
                            </div>
                            <div className="flex gap-2">
                              {itemSuggestedTranscriptScore !== null && itemSuggestedTranscriptScore !== undefined ? (
                                <button type="button" onClick={() => applySuggestedTranscriptScore(itemSuggestedTranscriptScore)} className="oa-btn-secondary px-3 py-1.5 text-xs">Use Score</button>
                              ) : null}
                              <button type="button" onClick={() => void validateSubmission(submission.id, "VALIDATED")} className="oa-btn-secondary px-3 py-1.5 text-xs">Validate</button>
                              <button type="button" onClick={() => void validateSubmission(submission.id, "REJECTED")} className="oa-btn-secondary px-3 py-1.5 text-xs">Reject</button>
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Candidate transcript</p>
                              <p className="mt-1 whitespace-pre-wrap rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm leading-6 text-[#1f1b3f]">{submission.final_transcript || "No transcript submitted"}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Reference transcript</p>
                              <p className="mt-1 whitespace-pre-wrap rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm leading-6 text-[#1f1b3f]">{item?.reference_transcript || "No reference transcript"}</p>
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                            <div className="rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Transcript comparison</p>
                              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-[#332d53]">
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Missed</p>
                                  <p>{metrics?.transcript_missing_words.length ? metrics.transcript_missing_words.join(", ") : "--"}</p>
                                </div>
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Added</p>
                                  <p>{metrics?.transcript_extra_words.length ? metrics.transcript_extra_words.join(", ") : "--"}</p>
                                </div>
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Wrong</p>
                                  <p>{metrics?.transcript_substitutions.length ? metrics.transcript_substitutions.map((item) => `${item.expected} -> ${item.actual}`).join(", ") : "--"}</p>
                                </div>
                              </div>
                            </div>
                            <div className="rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">PII comparison</p>
                              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-[#332d53]">
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Matched</p>
                                  <p>{metrics ? `${metrics.pii_matched_count}/${metrics.pii_expected_count}` : "--"}</p>
                                </div>
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Candidate rows</p>
                                  <p>{metrics?.pii_candidate_count ?? "--"}</p>
                                </div>
                                <div className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <p className="font-semibold">Expected rows</p>
                                  <p>{metrics?.pii_expected_count ?? "--"}</p>
                                </div>
                              </div>
                              <div className="mt-2 space-y-1 text-xs text-[#332d53]">
                                {metrics?.pii_missing.length ? (
                                  <p><span className="font-semibold">Missed:</span> {metrics.pii_missing.map(piiEntryLabel).join("; ")}</p>
                                ) : null}
                                {metrics?.pii_extra.length ? (
                                  <p><span className="font-semibold">Added:</span> {metrics.pii_extra.map(piiEntryLabel).join("; ")}</p>
                                ) : null}
                                {metrics?.pii_type_mismatches.length ? (
                                  <p>
                                    <span className="font-semibold">Wrong type:</span>{" "}
                                    {metrics.pii_type_mismatches
                                      .map((item) => `${piiEntryLabel(item.expected)} entered as ${item.actual.type}`)
                                      .join("; ")}
                                  </p>
                                ) : null}
                                {!metrics?.pii_missing.length && !metrics?.pii_extra.length && !metrics?.pii_type_mismatches.length ? (
                                  <p>No PII differences found</p>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                            <div className="rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">PII Answer</p>
                              <p className="mt-1">{submission.pii_reviewed ? "Reviewed" : "Not reviewed"}</p>
                              {submission.pii_entries.length > 0 ? (
                                <dl className="mt-2 space-y-1 text-xs text-[#332d53]">
                                  {submission.pii_entries.map((entry, index) => (
                                    <div key={`${entry.type}-${entry.value}-${index}`} className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                      <dt className="font-semibold">{entry.type}: {entry.value}</dt>
                                      <dd>{entry.timestamp ? `Time ${entry.timestamp}` : "No timestamp"}{entry.notes ? ` | ${entry.notes}` : ""}</dd>
                                    </div>
                                  ))}
                                </dl>
                              ) : (
                                <p className="mt-2 rounded-md bg-[#fbf8ff] px-2 py-1 text-xs text-[#332d53]">No structured PII rows</p>
                              )}
                              <p className="mt-2 whitespace-pre-wrap rounded-md bg-[#fbf8ff] px-2 py-1 text-xs text-[#332d53]">
                                {submission.pii_text || "No additional PII notes"}
                              </p>
                              {submission.pii_annotations.length > 0 ? (
                                <ul className="mt-2 space-y-1 text-xs text-[#332d53]">
                                  {submission.pii_annotations.map((annotation, index) => (
                                    <li key={`${annotation.label}-${annotation.start}-${annotation.end}-${index}`} className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                      <span className="font-semibold">{annotation.label}</span>: {annotation.value || "--"} ({annotation.start}-{annotation.end})
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                            <div className="rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Metadata</p>
                              {Object.entries(submission.metadata_values).length > 0 ? (
                                <dl className="mt-2 space-y-1 text-xs text-[#332d53]">
                                  {Object.entries(submission.metadata_values).map(([key, value]) => (
                                    <div key={key} className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                      <dt className="font-semibold">{key}</dt>
                                      <dd>{displayAnswerValue(value)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              ) : (
                                <p className="mt-1">No metadata answers</p>
                              )}
                            </div>
                            <div className="rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Validation</p>
                              <p className="mt-1">{submission.validation_status}</p>
                            </div>
                          </div>
                          {submission.notes ? (
                            <div className="mt-3 rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Candidate notes</p>
                              <p className="mt-1 whitespace-pre-wrap text-[#1f1b3f]">{submission.notes}</p>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                  <div className="mt-5 rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-4">
                    <h4 className="oa-title text-base font-semibold">Audit trail</h4>
                    <div className="mt-3 space-y-2">
                      {auditEvents.map((event) => (
                        <div key={event.id} className="rounded-lg border border-[#e5dbf1] bg-white px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold text-[#1f1b3f]">{event.action}</p>
                            <p className="text-xs text-[#7a7395]">{formatDateTime(event.created_at)}</p>
                          </div>
                          <p className="mt-1 text-xs text-[#5f5b79]">{event.actor_email ?? "System"} | {event.resource_type}</p>
                        </div>
                      ))}
                      {auditEvents.length === 0 ? <p className="text-sm text-[#5f5b79]">No audit events yet.</p> : null}
                    </div>
                  </div>
                </section>
              ) : null}
              {activeTab === "review" && !review ? (
                <section className="oa-card p-6 text-center text-sm text-[#5f5b79]">
                  Open the Candidates tab and choose Review on a submitted candidate.
                </section>
              ) : null}
            </>
          ) : (
            <section className="oa-card p-6 text-center text-sm text-[#5f5b79]">Select or create an assessment.</section>
          )}
        </main>
      </div>
      {answerViewerOpen && review ? (
        <div className="fixed inset-0 z-50 bg-[#17142b]/45 px-3 py-4 backdrop-blur-sm sm:px-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="candidate-answer-title"
            className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-xl border border-[#ded6ea] bg-white shadow-[0_28px_80px_-32px_rgba(18,13,40,0.9)]"
          >
            <div className="border-b border-[#eee5f8] px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7a7395]">Candidate answers</p>
                  <h2 id="candidate-answer-title" className="oa-title mt-1 truncate text-xl font-semibold">{review.candidate_name}</h2>
                  <p className="mt-1 text-sm text-[#5f5b79]">
                    {review.candidate_email} | {review.status} | Submitted {formatDateTime(review.submitted_at)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="oa-btn-secondary px-3 py-2 text-sm"
                    onClick={() => {
                      setAnswerViewerOpen(false);
                      setActiveTab("review");
                    }}
                  >
                    Open scoring view
                  </button>
                  <button type="button" className="oa-btn-quiet px-3 py-2 text-sm" onClick={() => setAnswerViewerOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-px overflow-hidden rounded-lg border border-[#eee5f8] bg-[#eee5f8] text-xs sm:grid-cols-4">
                <AdminAnswerMetric label="Progress" value={`${review.submissions.filter((submission) => submission.final_transcript.trim() || submission.pii_reviewed || Object.keys(submission.metadata_values).length > 0).length}/${review.items.length}`} />
                <AdminAnswerMetric label="Score" value={review.total_score === null ? "--" : String(review.total_score)} />
                <AdminAnswerMetric label="Decision" value={review.decision} />
                <AdminAnswerMetric label="Last save" value={formatDateTime(assignments.find((assignment) => assignment.id === review.id)?.last_saved_at ?? null)} />
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="flex min-h-[260px] flex-col border-b border-[#eee5f8] p-3 lg:min-h-0 lg:border-b-0 lg:border-r">
                <input
                  className="oa-input h-10 text-sm"
                  placeholder="Search answers"
                  value={answerSearch}
                  onChange={(event) => setAnswerSearch(event.target.value)}
                />
                <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                  {filteredAnswerSubmissions.slice(0, 250).map((submission) => {
                    const item = reviewItemsById.get(submission.item_id);
                    const answered = Boolean(
                      submission.final_transcript.trim() ||
                      submission.pii_reviewed ||
                      submission.pii_entries.length > 0 ||
                      Object.keys(submission.metadata_values).length > 0
                    );
                    return (
                      <button
                        key={submission.id}
                        type="button"
                        onClick={() => setSelectedAnswerSubmissionId(submission.id)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition ${
                          submission.id === selectedAnswerSubmission?.id
                            ? "border-[#b99bde] bg-white shadow-sm"
                            : "border-[#eee5f8] bg-[#fbf8ff] hover:bg-white"
                        }`}
                      >
                        <span className="block truncate font-semibold text-[#1f1b3f]" title={item?.original_filename ?? submission.item_id}>
                          {item?.original_filename ?? submission.item_id}
                        </span>
                        <span className="mt-1 flex items-center justify-between gap-2 text-[#5f5b79]">
                          <span>{answered ? "Answered" : "No answer"}</span>
                          <span className={submission.validation_status === "VALIDATED" ? "text-[#236140]" : submission.validation_status === "REJECTED" ? "text-[#a13a3a]" : "text-[#7a7395]"}>
                            {submission.validation_status}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredAnswerSubmissions.length > 250 ? (
                    <p className="rounded-lg border border-[#eee5f8] bg-white px-3 py-2 text-xs text-[#6b7280]">
                      Showing first 250 answers. Search to narrow the list.
                    </p>
                  ) : null}
                  {filteredAnswerSubmissions.length === 0 ? (
                    <p className="rounded-lg border border-[#eee5f8] bg-white px-3 py-2 text-xs text-[#6b7280]">No answers match this search.</p>
                  ) : null}
                </div>
              </aside>

              <div className="min-h-0 overflow-y-auto p-4">
                {selectedAnswerSubmission ? (
                  <article className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7a7395]">Audio file</p>
                        <h3 className="oa-title mt-1 truncate text-lg font-semibold" title={selectedAnswerItem?.original_filename ?? selectedAnswerSubmission.item_id}>
                          {selectedAnswerItem?.original_filename ?? selectedAnswerSubmission.item_id}
                        </h3>
                        <p className="mt-1 text-xs text-[#7a7395]">
                          Saved {formatDateTime(selectedAnswerSubmission.last_saved_at)} | Submitted {formatDateTime(selectedAnswerSubmission.submitted_at)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void validateSubmission(selectedAnswerSubmission.id, "VALIDATED")} className="oa-btn-secondary px-3 py-1.5 text-xs">Validate</button>
                        <button type="button" onClick={() => void validateSubmission(selectedAnswerSubmission.id, "REJECTED")} className="oa-btn-secondary px-3 py-1.5 text-xs">Reject</button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                      <section className="rounded-xl border border-[#e5dbf1] bg-[#fbf8ff] p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Candidate transcript</p>
                        <p className="mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm leading-6 text-[#1f1b3f]">
                          {selectedAnswerSubmission.final_transcript || "No transcript submitted"}
                        </p>
                      </section>
                      <section className="rounded-xl border border-[#e5dbf1] bg-[#fbf8ff] p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">PII answer</p>
                        <div className="mt-2 rounded-lg border border-[#e5dbf1] bg-white p-3 text-sm">
                          <p className={selectedAnswerSubmission.pii_reviewed ? "font-semibold text-[#236140]" : "font-semibold text-[#8a5b1e]"}>
                            {selectedAnswerSubmission.pii_reviewed ? "PII reviewed" : "PII not reviewed"}
                          </p>
                          {selectedAnswerSubmission.pii_entries.length > 0 ? (
                            <dl className="mt-3 space-y-2 text-xs text-[#332d53]">
                              {selectedAnswerSubmission.pii_entries.map((entry, index) => (
                                <div key={`${entry.type}-${entry.value}-${index}`} className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <dt className="font-semibold">{entry.type}: {entry.value}</dt>
                                  <dd>{entry.timestamp ? `Time ${entry.timestamp}` : "No timestamp"}{entry.notes ? ` | ${entry.notes}` : ""}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <p className="mt-3 rounded-md bg-[#fbf8ff] px-2 py-1 text-xs text-[#332d53]">No structured PII rows</p>
                          )}
                          <p className="mt-3 whitespace-pre-wrap rounded-md bg-[#fbf8ff] px-2 py-1 text-xs text-[#332d53]">
                            {selectedAnswerSubmission.pii_text || "No additional PII notes"}
                          </p>
                        </div>
                      </section>
                    </div>

                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                      <section className="rounded-xl border border-[#e5dbf1] bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Metadata</p>
                        {Object.entries(selectedAnswerSubmission.metadata_values).length > 0 ? (
                          <dl className="mt-2 space-y-2 text-xs text-[#332d53]">
                            {Object.entries(selectedAnswerSubmission.metadata_values).map(([key, value]) => {
                              const field = review.assessment.metadata_schema.find((candidate) => candidate.key === key);
                              return (
                                <div key={key} className="rounded-md bg-[#fbf8ff] px-2 py-1">
                                  <dt className="font-semibold">{field?.label ?? key}</dt>
                                  <dd>{displayAnswerValue(value)}</dd>
                                </div>
                              );
                            })}
                          </dl>
                        ) : (
                          <p className="mt-2 text-sm text-[#5f5b79]">No metadata answers</p>
                        )}
                      </section>
                      <section className="rounded-xl border border-[#e5dbf1] bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Candidate notes</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-[#1f1b3f]">{selectedAnswerSubmission.notes || "No notes"}</p>
                      </section>
                      <section className="rounded-xl border border-[#e5dbf1] bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Validation</p>
                        <p className="mt-2 text-sm font-semibold text-[#1f1b3f]">{selectedAnswerSubmission.validation_status}</p>
                        {selectedAnswerSubmission.validation_feedback ? (
                          <p className="mt-2 text-sm text-[#5f5b79]">{selectedAnswerSubmission.validation_feedback}</p>
                        ) : null}
                      </section>
                    </div>

                    {selectedAnswerSubmission.reference_metrics ? (
                      <section className="rounded-xl border border-[#e5dbf1] bg-[#fbf8ff] p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a7395]">Reference comparison</p>
                        <div className="mt-3 grid gap-2 text-xs text-[#332d53] md:grid-cols-4">
                          <div className="rounded-lg bg-white p-3">
                            <p className="font-semibold">Accuracy</p>
                            <p className="mt-1">{formatPercent(selectedAnswerSubmission.reference_metrics.transcript_accuracy_percent)}</p>
                          </div>
                          <div className="rounded-lg bg-white p-3">
                            <p className="font-semibold">WER</p>
                            <p className="mt-1">{formatWer(selectedAnswerSubmission.reference_metrics.word_error_rate)}</p>
                          </div>
                          <div className="rounded-lg bg-white p-3">
                            <p className="font-semibold">PII matched</p>
                            <p className="mt-1">{selectedAnswerSubmission.reference_metrics.pii_matched_count}/{selectedAnswerSubmission.reference_metrics.pii_expected_count}</p>
                          </div>
                          <div className="rounded-lg bg-white p-3">
                            <p className="font-semibold">Suggested score</p>
                            <p className="mt-1">{formatSuggestion(selectedAnswerSubmission)}</p>
                          </div>
                        </div>
                      </section>
                    ) : null}
                  </article>
                ) : (
                  <div className="rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-6 text-center text-sm text-[#5f5b79]">
                    No submitted answers are available for this candidate yet.
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function AdminAnswerMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7a7395]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[#1f1b3f]" title={value}>{value}</p>
    </div>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="oa-card px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7a7395]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#1f1b3f]">{value}</p>
    </div>
  );
}

function AdminTabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
        active ? "bg-[#241f43] text-white shadow-sm" : "text-[#5f5b79] hover:bg-[#f7f2ff]"
      }`}
    >
      {children}
    </button>
  );
}

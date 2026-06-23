"use client";

import type { HiringMetadataField, HiringPIIEntry, HiringSubmission } from "@outcomes/shared-types";
import { useParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { AudioWaveformPlayer } from "@/components/audio-waveform-player";
import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  fetchCandidateHiringAssignment,
  patchCandidateHiringSubmission,
  streamCandidateHiringAudio,
  submitCandidateHiringAssignment,
} from "@/lib/api";
import { defaultHiringInstructions } from "@/lib/hiring-instructions";

function metadataReady(fields: HiringMetadataField[], values: Record<string, unknown>) {
  return fields.every((field) => !field.required || String(values[field.key] ?? "").trim() !== "");
}

function formatDate(value: string | null) {
  if (!value) return "No due date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function formatDateTime(value: string | null) {
  if (!value) return "Not saved yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function formatDeadline(value: string | null, fallbackDate: string | null) {
  if (value) return formatDateTime(value);
  return formatDate(fallbackDate);
}

function formatDuration(totalSeconds: number | null) {
  if (totalSeconds === null) return "No time limit";
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function emptyPIIEntry(): HiringPIIEntry {
  return { type: "", value: "", timestamp: "", notes: "" };
}

function cleanPIIEntries(entries: HiringPIIEntry[]) {
  return entries
    .map((entry) => ({
      type: entry.type.trim(),
      value: entry.value.trim(),
      timestamp: entry.timestamp?.trim() || null,
      notes: entry.notes?.trim() || null,
    }))
    .filter((entry) => entry.type && entry.value);
}

interface CandidateSubmissionDraft {
  final_transcript: string;
  pii_text: string;
  pii_entries: HiringPIIEntry[];
  notes: string;
  metadata_values: Record<string, unknown>;
  pii_reviewed: boolean;
}

function draftSignature(draft: CandidateSubmissionDraft) {
  return JSON.stringify(draft);
}

function submissionReady(
  submission: HiringSubmission | null | undefined,
  fields: HiringMetadataField[],
  draft?: { transcript: string; piiReviewed: boolean; metadata: Record<string, unknown> }
) {
  const transcript = draft?.transcript ?? submission?.final_transcript ?? "";
  const piiReviewed = draft?.piiReviewed ?? submission?.pii_reviewed ?? false;
  const metadata = draft?.metadata ?? submission?.metadata_values ?? {};
  return {
    transcript: Boolean(transcript.trim()),
    pii: piiReviewed,
    metadata: metadataReady(fields, metadata),
  };
}

export default function CandidateHiringAssignmentPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const { accessToken, user } = useAuth();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchCandidateHiringAssignment>> | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [draftTranscript, setDraftTranscript] = useState("");
  const [draftPIIText, setDraftPIIText] = useState("");
  const [draftPIIEntries, setDraftPIIEntries] = useState<HiringPIIEntry[]>([]);
  const [draftNotes, setDraftNotes] = useState("");
  const [draftMetadata, setDraftMetadata] = useState<Record<string, unknown>>({});
  const [piiReviewed, setPiiReviewed] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deferredItemSearch = useDeferredValue(itemSearch);
  const saveInFlightRef = useRef(false);
  const queuedAutoSaveRef = useRef(false);
  const saveSubmissionRef = useRef<(manual?: boolean) => Promise<boolean>>(async () => false);
  const latestDraftSignatureRef = useRef("");

  useEffect(() => {
    if (!accessToken || !assignmentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const assignment = await fetchCandidateHiringAssignment(accessToken, assignmentId);
        if (!cancelled) {
          setDetail(assignment);
          setSelectedItemId(assignment.items[0]?.id ?? null);
          setSecondsRemaining(assignment.seconds_remaining);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Could not load hiring assignment");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, assignmentId]);

  const selectedItem = useMemo(
    () => detail?.items.find((item) => item.id === selectedItemId) ?? null,
    [detail?.items, selectedItemId]
  );
  const selectedSubmission = useMemo(
    () => detail?.submissions.find((submission) => submission.item_id === selectedItemId) ?? null,
    [detail?.submissions, selectedItemId]
  );
  const submissionsByItemId = useMemo(
    () => new Map((detail?.submissions ?? []).map((submission) => [submission.item_id, submission])),
    [detail?.submissions]
  );
  const readOnly = detail?.status === "SUBMITTED" || detail?.status === "EVALUATED";
  const assessmentActive = detail?.assessment.status === "ACTIVE";
  const assessmentInactive = Boolean(detail && !assessmentActive && !readOnly);
  const timeExpired = secondsRemaining !== null && secondsRemaining <= 0 && !readOnly;
  const editingDisabled = readOnly || assessmentInactive || timeExpired;
  const candidateBlockedMessage = assessmentInactive
    ? "Hiring assessment is not active. Ask an admin to activate it before starting."
    : timeExpired
      ? "Time is up. Ask an admin to extend the deadline if you need more time."
      : null;
  const visibleError = error && error !== candidateBlockedMessage ? error : null;
  const transcriptWordCount = draftTranscript.trim() ? draftTranscript.trim().split(/\s+/).length : 0;
  const selectedItemIndex = detail?.items.findIndex((item) => item.id === selectedItemId) ?? -1;
  const searchNeedle = deferredItemSearch.trim().toLowerCase();
  const filteredItems = useMemo(
    () =>
      (detail?.items ?? []).filter((item) => {
        if (!searchNeedle) return true;
        return `${item.original_filename} ${item.external_id ?? ""}`.toLowerCase().includes(searchNeedle);
      }),
    [detail?.items, searchNeedle]
  );
  const visibleQueueItems = filteredItems.slice(0, 300);
  const nextItemAfterSelected = useMemo(() => {
    if (!detail || !selectedItemId) return null;
    const currentFilteredIndex = filteredItems.findIndex((item) => item.id === selectedItemId);
    const queue = currentFilteredIndex >= 0 ? filteredItems : detail.items;
    const currentIndex = currentFilteredIndex >= 0 ? currentFilteredIndex : queue.findIndex((item) => item.id === selectedItemId);
    return currentIndex >= 0 ? queue[currentIndex + 1] ?? null : null;
  }, [detail, filteredItems, selectedItemId]);
  function readinessForSubmission(submission: HiringSubmission) {
    return submissionReady(
      submission,
      detail?.assessment.metadata_schema ?? [],
      submission.id === selectedSubmission?.id
        ? {
            transcript: draftTranscript,
            piiReviewed,
            metadata: draftMetadata,
          }
        : undefined
    );
  }

  const completedItems = detail?.submissions.filter((submission) => {
    const readiness = readinessForSubmission(submission);
    return readiness.transcript && readiness.pii && readiness.metadata;
  }).length ?? 0;
  const allReady = Boolean(
    detail &&
      detail.submissions.length > 0 &&
      detail.submissions.every((submission) => {
        const readiness = readinessForSubmission(submission);
        return readiness.transcript && readiness.pii && readiness.metadata;
      })
  );
  const currentReadiness = submissionReady(selectedSubmission, detail?.assessment.metadata_schema ?? [], {
    transcript: draftTranscript,
    piiReviewed,
    metadata: draftMetadata,
  });
  const candidateInstructions = detail ? detail.assessment.instructions.trim() || defaultHiringInstructions : "";
  const reviewedPIIEntries = useMemo(() => cleanPIIEntries(draftPIIEntries), [draftPIIEntries]);
  const piiEntryCount = reviewedPIIEntries.length;
  const piiStatusText = piiReviewed ? "PII review complete" : "PII review required";
  const autoSaveText =
    saveState === "saving"
      ? "Auto-saving changes..."
      : saveState === "failed"
        ? "Auto-save failed. Use Save now."
        : saveState === "unsaved"
          ? "Changes will auto-save shortly"
          : `Auto-saved ${formatDateTime(lastSavedAt)}`;
  const submitSummary = detail?.items.map((item) => {
    const submission = submissionsByItemId.get(item.id);
    return {
      item,
      readiness: submission ? readinessForSubmission(submission) : submissionReady(submission, detail.assessment.metadata_schema),
    };
  }) ?? [];

  useEffect(() => {
    setInstructionsOpen(Boolean(candidateInstructions));
  }, [detail?.id, candidateInstructions]);

  useEffect(() => {
    if (!selectedSubmission) return;
    setDraftTranscript(selectedSubmission.final_transcript);
    setDraftPIIText(selectedSubmission.pii_text);
    setDraftPIIEntries(selectedSubmission.pii_entries);
    setDraftNotes(selectedSubmission.notes);
    setDraftMetadata(selectedSubmission.metadata_values);
    setPiiReviewed(selectedSubmission.pii_reviewed);
    setDraftDirty(false);
    setSaveState("saved");
    setLastSavedAt(selectedSubmission.last_saved_at);
    setMessage(null);
    setError(null);
  }, [selectedSubmission?.id]);

  useEffect(() => {
    latestDraftSignatureRef.current = draftSignature({
      final_transcript: draftTranscript,
      pii_text: draftPIIText,
      pii_entries: reviewedPIIEntries,
      notes: draftNotes,
      metadata_values: draftMetadata,
      pii_reviewed: piiReviewed,
    });
  }, [draftMetadata, draftNotes, draftPIIText, draftTranscript, piiReviewed, reviewedPIIEntries]);

  useEffect(() => {
    setSecondsRemaining(detail?.seconds_remaining ?? null);
  }, [detail?.seconds_remaining]);

  useEffect(() => {
    if (secondsRemaining === null || readOnly) return;
    const intervalId = window.setInterval(() => {
      setSecondsRemaining((previous) => (previous === null ? null : Math.max(0, previous - 1)));
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [secondsRemaining, readOnly]);

  useEffect(() => {
    return () => {
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
    };
  }, []);

  useEffect(() => {
    if (!accessToken || !selectedItem || editingDisabled) {
      setAudioBusy(false);
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      return;
    }
    let cancelled = false;
    setAudioBusy(true);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    void streamCandidateHiringAudio(accessToken, assignmentId, selectedItem.id)
      .then((response) => {
        if (cancelled) return;
        setAudioUrl(URL.createObjectURL(response.blob));
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Audio load failed");
      })
      .finally(() => {
        if (!cancelled) setAudioBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, assignmentId, selectedItem?.id, editingDisabled]);

  async function refresh() {
    if (!accessToken) return;
    const next = await fetchCandidateHiringAssignment(accessToken, assignmentId);
    setDetail(next);
  }

  useEffect(() => {
    if (!accessToken || !assignmentId || readOnly) return;
    const intervalId = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(intervalId);
  }, [accessToken, assignmentId, readOnly]);

  function markDirty() {
    setDraftDirty(true);
    setSaveState("unsaved");
    setMessage(null);
  }

  async function saveSubmission(manual = true): Promise<boolean> {
    if (!accessToken || !selectedSubmission || editingDisabled) return false;
    if (!manual && !draftDirty) return true;
    if (saveInFlightRef.current) {
      queuedAutoSaveRef.current = true;
      setSaveState("saving");
      return false;
    }
    const draftSnapshot: CandidateSubmissionDraft = {
      final_transcript: draftTranscript,
      pii_text: draftPIIText,
      pii_entries: reviewedPIIEntries,
      notes: draftNotes,
      metadata_values: draftMetadata,
      pii_reviewed: piiReviewed,
    };
    const savedSignature = draftSignature(draftSnapshot);
    saveInFlightRef.current = true;
    if (manual) setBusy(true);
    setSaveState("saving");
    try {
      const updated = await patchCandidateHiringSubmission(accessToken, selectedSubmission.id, {
        version: selectedSubmission.version,
        ...draftSnapshot,
      });
      const nextSubmission = updated.submissions.find((submission) => submission.id === selectedSubmission.id);
      const hasNewerDraft = latestDraftSignatureRef.current !== savedSignature;
      setDetail(updated);
      setDraftDirty(hasNewerDraft);
      setSaveState(hasNewerDraft ? "unsaved" : "saved");
      setLastSavedAt(nextSubmission?.last_saved_at ?? new Date().toISOString());
      if (hasNewerDraft) queuedAutoSaveRef.current = true;
      if (manual) setMessage("Saved");
      setError(null);
      return true;
    } catch (err) {
      setSaveState("failed");
      setError(err instanceof APIError ? err.message : "Save failed");
      return false;
    } finally {
      saveInFlightRef.current = false;
      if (manual) setBusy(false);
      if (queuedAutoSaveRef.current && !editingDisabled) {
        queuedAutoSaveRef.current = false;
        window.setTimeout(() => void saveSubmissionRef.current(false), 0);
      }
    }
  }

  useEffect(() => {
    saveSubmissionRef.current = saveSubmission;
  });

  async function selectItem(itemId: string) {
    if (itemId === selectedItemId) return;
    if (draftDirty && !editingDisabled) {
      const saved = await saveSubmission(false);
      if (!saved) return;
    }
    setSelectedItemId(itemId);
  }

  async function saveAndAdvance() {
    const saved = await saveSubmission(true);
    if (!saved) return;
    if (nextItemAfterSelected) {
      setSelectedItemId(nextItemAfterSelected.id);
    }
  }

  useEffect(() => {
    if (!draftDirty || editingDisabled || !selectedSubmission) return;
    const timeoutId = window.setTimeout(() => void saveSubmission(false), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [
    draftDirty,
    editingDisabled,
    selectedSubmission?.id,
    selectedSubmission?.version,
    draftTranscript,
    draftPIIText,
    draftPIIEntries,
    draftNotes,
    draftMetadata,
    piiReviewed,
  ]);

  useEffect(() => {
    function saveBeforeLeaving() {
      if (document.visibilityState === "hidden" && draftDirty && !editingDisabled && selectedSubmission) {
        void saveSubmission(false);
      }
    }

    function saveBeforePageHide() {
      if (draftDirty && !editingDisabled && selectedSubmission) {
        void saveSubmission(false);
      }
    }

    document.addEventListener("visibilitychange", saveBeforeLeaving);
    window.addEventListener("pagehide", saveBeforePageHide);
    return () => {
      document.removeEventListener("visibilitychange", saveBeforeLeaving);
      window.removeEventListener("pagehide", saveBeforePageHide);
    };
  }, [
    draftDirty,
    editingDisabled,
    selectedSubmission?.id,
    selectedSubmission?.version,
    draftTranscript,
    draftPIIText,
    draftPIIEntries,
    draftNotes,
    draftMetadata,
    piiReviewed,
  ]);

  async function submit() {
    if (!accessToken || !detail || !allReady) return;
    setBusy(true);
    try {
      const updated = await submitCandidateHiringAssignment(accessToken, detail.id);
      setDetail(updated);
      setConfirmSubmitOpen(false);
      setMessage("Submitted");
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function prepareSubmit() {
    if (!detail || !allReady || editingDisabled) return;
    if (draftDirty) {
      const saved = await saveSubmission(false);
      if (!saved) return;
    }
    setConfirmSubmitOpen(true);
  }

  if (!detail) {
    return <div className="oa-card px-4 py-3 text-sm text-[#5f5b79]">{error ?? "Loading hiring test..."}</div>;
  }

  return (
    <section className="animate-fade-in space-y-3 xl:flex xl:h-[calc(100vh-154px)] xl:min-h-[660px] xl:flex-col xl:overflow-hidden">
      <div className="rounded-xl border border-[#e4e7ee] bg-white shadow-[0_18px_40px_-34px_rgba(15,23,42,0.55)]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="oa-title truncate text-lg font-semibold">{detail.assessment.title}</h1>
              <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2 py-0.5 text-[11px] font-semibold text-[#1d4ed8]">
                {detail.status}
              </span>
              <span className="rounded-full border border-[#e2e8f0] bg-[#f8fafc] px-2 py-0.5 text-[11px] font-medium text-[#475569]">
                {user?.email ?? "candidate"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {candidateInstructions ? (
              <button type="button" onClick={() => setInstructionsOpen(true)} className="oa-btn-secondary px-3 py-1.5 text-sm">
                Instructions
              </button>
            ) : null}
            <button type="button" onClick={prepareSubmit} disabled={busy || editingDisabled || !allReady} className="oa-btn-primary px-4 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
              {readOnly ? "Submitted" : "Submit Test"}
            </button>
          </div>
        </div>
        <div className="grid gap-px border-t border-[#eef2f7] bg-[#eef2f7] text-xs sm:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Progress" value={`${completedItems}/${detail.items.length}`} />
          <MetricTile label="Selected" value={selectedItemIndex >= 0 ? `${selectedItemIndex + 1}/${detail.items.length}` : "--"} />
          <MetricTile label="Words" value={String(transcriptWordCount)} />
          <MetricTile label="Time left" value={formatDuration(secondsRemaining)} tone={timeExpired ? "danger" : "default"} />
          <MetricTile label="Deadline" value={detail.submission_deadline_at ? formatDateTime(detail.submission_deadline_at) : "No deadline"} />
          <MetricTile label="Save" value={saveState === "saving" ? "Saving" : saveState === "failed" ? "Failed" : saveState === "unsaved" ? "Unsaved" : "Saved"} />
        </div>
      </div>

      {(candidateBlockedMessage || visibleError || message) ? (
        <div className="space-y-2">
          {candidateBlockedMessage ? <p className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">{candidateBlockedMessage}</p> : null}
          {visibleError ? <p className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">{visibleError}</p> : null}
          {message ? <p className="rounded-lg border border-[#c8e6d4] bg-[#f0fbf4] px-3 py-2 text-sm text-[#236140]">{message}</p> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="oa-card flex min-h-[320px] flex-col overflow-hidden p-3 xl:min-h-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="oa-title text-sm font-semibold">Audio Queue</h2>
              <p className="text-xs text-[#6b7280]">{filteredItems.length} shown</p>
            </div>
            <span className="rounded-full bg-[#f3ebff] px-2 py-1 text-xs font-semibold text-[#5d3f84]">
              {Math.round((completedItems / Math.max(detail.items.length, 1)) * 100)}%
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#ece5f6]">
            <div className="h-full rounded-full bg-[#241f43]" style={{ width: `${Math.round((completedItems / Math.max(detail.items.length, 1)) * 100)}%` }} />
          </div>
          <input
            className="oa-input mt-3 h-9 text-sm"
            placeholder="Search audio"
            value={itemSearch}
            onChange={(event) => setItemSearch(event.target.value)}
          />
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {visibleQueueItems.map((item) => {
              const submission = submissionsByItemId.get(item.id);
              const checklist = submissionReady(submission, detail.assessment.metadata_schema);
              const ready = checklist.transcript && checklist.pii && checklist.metadata;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void selectItem(item.id)}
                  className={`w-full rounded-lg border px-2 py-2 text-left text-xs transition ${
                    item.id === selectedItemId ? "border-[#b99bde] bg-white shadow-sm" : "border-[#eee5f8] bg-[#fbf8ff] hover:bg-white"
                  }`}
                >
                  <span className="block truncate font-semibold text-[#1f1b3f]" title={item.original_filename}>{item.original_filename}</span>
                  <span className="mt-1 flex items-center justify-between gap-2">
                    <span className={ready ? "font-medium text-[#236140]" : "font-medium text-[#8a5b1e]"}>
                      {ready ? "Ready" : "Needs work"}
                    </span>
                    <span className="flex gap-1">
                      <StatusDot ready={checklist.transcript} label="Transcript" />
                      <StatusDot ready={checklist.pii} label="PII" />
                      <StatusDot ready={checklist.metadata} label="Metadata" />
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredItems.length > visibleQueueItems.length ? (
              <p className="rounded-lg border border-[#eee5f8] bg-white px-2 py-2 text-xs text-[#6b7280]">
                Showing first {visibleQueueItems.length}. Search to narrow the queue.
              </p>
            ) : null}
            {filteredItems.length === 0 ? (
              <p className="rounded-lg border border-[#eee5f8] bg-white px-2 py-2 text-xs text-[#6b7280]">No audio matches this search.</p>
            ) : null}
          </div>
        </aside>

        {selectedItem && selectedSubmission ? (
          <div className="min-h-0 space-y-3 xl:overflow-y-auto xl:pr-1">
            <div className="oa-card p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="oa-title text-xs font-semibold uppercase tracking-[0.1em] text-[#4b5563]">Audio</h2>
                  <p className="mt-0.5 truncate text-sm font-semibold text-[#1f1b3f]" title={selectedItem.original_filename}>{selectedItem.original_filename}</p>
                </div>
              </div>
              <div className="mb-2 grid gap-2 text-xs text-[#4b5563] sm:grid-cols-3">
                <ChecklistPill label="Transcript" ready={currentReadiness.transcript} />
                <ChecklistPill label="PII reviewed" ready={currentReadiness.pii} />
                <ChecklistPill label="Metadata" ready={currentReadiness.metadata} />
              </div>
              {candidateBlockedMessage ? (
                <div className="rounded-xl border border-[#f0c8c8] bg-[#fff8f8] px-3 py-4 text-sm text-[#8a3434]">{candidateBlockedMessage}</div>
              ) : audioBusy ? (
                <div className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-4 text-sm text-[#5f5b79]">Loading audio...</div>
              ) : (
                <AudioWaveformPlayer audioUrl={audioUrl} />
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1.25fr)_390px]">
              <div className="space-y-3">
                <div className="oa-card p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="oa-title text-sm font-semibold" htmlFor="candidate-transcript">
                      Final Transcript
                    </label>
                    <span className="text-xs text-[#6b7280]">Manual entry</span>
                  </div>
                  <textarea
                    id="candidate-transcript"
                    aria-label="Final Transcript"
                    value={draftTranscript}
                    onChange={(event) => {
                      setDraftTranscript(event.target.value);
                      markDirty();
                    }}
                    disabled={editingDisabled}
                    rows={10}
                    className="oa-textarea min-h-[320px] bg-white font-mono text-[15px] disabled:bg-[#f5f2f8] xl:min-h-[360px]"
                    placeholder="Start typing the transcript from the audio..."
                  />
                </div>

                <div className="oa-card p-3">
                  <label className="text-sm font-semibold text-[#332d53]" htmlFor="candidate-notes">
                    Notes to evaluator
                  </label>
                  <textarea
                    id="candidate-notes"
                    value={draftNotes}
                    onChange={(event) => {
                      setDraftNotes(event.target.value);
                      markDirty();
                    }}
                    disabled={editingDisabled}
                    className="oa-textarea mt-2 min-h-[72px] disabled:bg-[#f5f2f8]"
                    placeholder="Optional context about unclear speech, uncertainty, or assumptions."
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="oa-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="oa-title text-base font-semibold">PII Answer</h3>
                      <p className="mt-0.5 text-xs font-medium text-[#6b7280]">{piiEntryCount} PII row{piiEntryCount === 1 ? "" : "s"} captured</p>
                    </div>
                  </div>
                  <div
                    className={`mt-3 rounded-xl border px-3 py-3 ${
                      piiReviewed
                        ? "border-[#a7dfb8] bg-[#f0fbf4]"
                        : "border-[#f2c083] bg-[#fff8ec]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6f6688]">Review status</p>
                        <p className={`mt-1 text-sm font-semibold ${piiReviewed ? "text-[#236140]" : "text-[#8a5b1e]"}`}>
                          {piiStatusText}
                        </p>
                        <p className="mt-1 text-xs text-[#5f5b79]">Required before this audio can be submitted.</p>
                      </div>
                      <button
                        type="button"
                        aria-pressed={piiReviewed}
                        disabled={editingDisabled}
                        onClick={() => {
                          setPiiReviewed((previous) => !previous);
                          markDirty();
                        }}
                        className={`rounded-lg border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          piiReviewed
                            ? "border-[#91d5a9] bg-white text-[#236140] hover:bg-[#f7fff9]"
                            : "border-[#c47a20] bg-[#8a5b1e] text-white hover:bg-[#744b18]"
                        }`}
                      >
                        {piiReviewed ? "Reviewed" : "Mark PII reviewed"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {draftPIIEntries.map((entry, index) => (
                      <div key={index} className="rounded-lg border border-[#e5dbf1] bg-[#fbf8ff] p-2">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <input
                            className="oa-input h-9"
                            placeholder="PII type"
                            value={entry.type}
                            disabled={editingDisabled}
                            onChange={(event) => {
                              setDraftPIIEntries((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item));
                              setPiiReviewed(false);
                              markDirty();
                            }}
                          />
                          <input
                            className="oa-input h-9"
                            placeholder="Value heard"
                            value={entry.value}
                            disabled={editingDisabled}
                            onChange={(event) => {
                              setDraftPIIEntries((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item));
                              setPiiReviewed(false);
                              markDirty();
                            }}
                          />
                          <input
                            className="oa-input h-9"
                            placeholder="Approx time"
                            value={entry.timestamp ?? ""}
                            disabled={editingDisabled}
                            onChange={(event) => {
                              setDraftPIIEntries((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, timestamp: event.target.value } : item));
                              setPiiReviewed(false);
                              markDirty();
                            }}
                          />
                          <input
                            className="oa-input h-9"
                            placeholder="Notes"
                            value={entry.notes ?? ""}
                            disabled={editingDisabled}
                            onChange={(event) => {
                              setDraftPIIEntries((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, notes: event.target.value } : item));
                              setPiiReviewed(false);
                              markDirty();
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={editingDisabled}
                          onClick={() => {
                            setDraftPIIEntries((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
                            setPiiReviewed(false);
                            markDirty();
                          }}
                          className="oa-btn-quiet mt-2 px-2.5 py-1 text-xs disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={editingDisabled}
                      onClick={() => {
                        setDraftPIIEntries((prev) => [...prev, emptyPIIEntry()]);
                        setPiiReviewed(false);
                        markDirty();
                      }}
                      className="oa-btn-secondary px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      Add PII Row
                    </button>
                  </div>
                  <textarea
                    aria-label="Additional PII notes"
                    value={draftPIIText}
                    onChange={(event) => {
                      setDraftPIIText(event.target.value);
                      setPiiReviewed(false);
                      markDirty();
                    }}
                    disabled={editingDisabled}
                    className="oa-textarea mt-3 min-h-[84px] disabled:bg-[#f5f2f8]"
                    placeholder="Optional: write None or add extra PII notes."
                  />
                </div>

                <div className="oa-card p-3">
                  <h3 className="oa-title text-base font-semibold">Metadata</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
                    {detail.assessment.metadata_schema.length === 0 ? (
                      <p className="text-sm text-[#5f5b79]">No metadata fields configured.</p>
                    ) : (
                      detail.assessment.metadata_schema.map((field) => (
                        <label key={field.key} className="block text-sm">
                          <span className="font-medium text-[#332d53]">
                            {field.label}{field.required ? " *" : ""}
                          </span>
                          {field.type === "select" ? (
                            <select
                              value={String(draftMetadata[field.key] ?? "")}
                              onChange={(event) => {
                                setDraftMetadata((prev) => ({ ...prev, [field.key]: event.target.value }));
                                markDirty();
                              }}
                              disabled={editingDisabled}
                              className="oa-select mt-1 disabled:bg-[#f5f2f8]"
                            >
                              <option value="">Select</option>
                              {field.options.map((option) => (
                                <option key={option} value={option}>{option}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                              value={String(draftMetadata[field.key] ?? "")}
                              onChange={(event) => {
                                setDraftMetadata((prev) => ({ ...prev, [field.key]: event.target.value }));
                                markDirty();
                              }}
                              disabled={editingDisabled}
                              className="oa-input mt-1 disabled:bg-[#f5f2f8]"
                            />
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e4dcf0] bg-white/95 px-3 py-2 shadow-[0_-16px_32px_-28px_rgba(18,13,40,0.6)] backdrop-blur">
              <span className={`text-xs font-semibold ${saveState === "failed" ? "text-[#a13a3a]" : saveState === "saved" ? "text-[#236140]" : "text-[#5f5b79]"}`}>
                {autoSaveText}
              </span>
              <button type="button" onClick={() => void saveAndAdvance()} disabled={busy || editingDisabled || saveState === "saving"} className="oa-btn-primary px-5 py-2 text-sm font-semibold disabled:opacity-50">
                {nextItemAfterSelected ? "Save & Next" : "Save now"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {instructionsOpen && candidateInstructions ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#17142b]/40 px-4 py-6">
          <section role="dialog" aria-modal="true" aria-labelledby="candidate-instructions-title" className="oa-card max-h-[88vh] w-full max-w-2xl overflow-auto p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7a7395]">Hiring test</p>
                <h2 id="candidate-instructions-title" className="oa-title text-lg font-semibold">Instructions</h2>
              </div>
              <button type="button" className="oa-btn-quiet px-2.5 py-1 text-sm" onClick={() => setInstructionsOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 whitespace-pre-wrap rounded-xl border border-[#eee5f8] bg-[#fbf8ff] p-4 text-sm leading-6 text-[#1f1b3f]">
              {candidateInstructions}
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" className="oa-btn-primary px-4 py-2 text-sm font-semibold" onClick={() => setInstructionsOpen(false)}>
                Start test
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {confirmSubmitOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#17142b]/40 px-4 py-6">
          <section className="oa-card max-h-[90vh] w-full max-w-2xl overflow-auto p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="oa-title text-lg font-semibold">Submit Test</h2>
                <p className="mt-1 text-sm text-[#5f5b79]">Once submitted, answers become read-only for evaluation.</p>
              </div>
              <button type="button" className="oa-btn-quiet px-2.5 py-1 text-sm" onClick={() => setConfirmSubmitOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {submitSummary.map(({ item, readiness }) => (
                <div key={item.id} className="rounded-lg border border-[#eee5f8] bg-[#fbf8ff] px-3 py-2 text-sm">
                  <p className="font-semibold text-[#1f1b3f]">{item.original_filename}</p>
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                    <ChecklistPill label="Transcript" ready={readiness.transcript} />
                    <ChecklistPill label="PII reviewed" ready={readiness.pii} />
                    <ChecklistPill label="Metadata" ready={readiness.metadata} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="oa-btn-secondary px-4 py-2 text-sm" onClick={() => setConfirmSubmitOpen(false)}>
                Keep Editing
              </button>
              <button type="button" className="oa-btn-primary px-4 py-2 text-sm font-semibold disabled:opacity-50" disabled={busy || !allReady} onClick={submit}>
                Confirm Submit
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ChecklistPill({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={`rounded-lg border px-2.5 py-1.5 font-semibold ${ready ? "border-[#bfe5cb] bg-[#f1fbf5] text-[#266544]" : "border-[#ffd9a8] bg-[#fff8ec] text-[#925b17]"}`}>
      {label}: {ready ? "Done" : "Missing"}
    </span>
  );
}

function MetricTile({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "danger" }) {
  return (
    <div className="bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7a7395]">{label}</p>
      <p className={`mt-0.5 truncate text-xs font-semibold ${tone === "danger" ? "text-[#a13a3a]" : "text-[#1f1b3f]"}`} title={value}>
        {value}
      </p>
    </div>
  );
}

function StatusDot({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      aria-label={`${label}: ${ready ? "done" : "missing"}`}
      title={`${label}: ${ready ? "done" : "missing"}`}
      className={`h-2 w-2 rounded-full ${ready ? "bg-[#2f8a56]" : "bg-[#c47a20]"}`}
    />
  );
}

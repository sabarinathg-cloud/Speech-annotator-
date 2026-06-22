"use client";

import type { HiringAssessmentItem, HiringMetadataField, HiringPIIEntry, HiringSubmission } from "@outcomes/shared-types";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AudioWaveformPlayer } from "@/components/audio-waveform-player";
import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  downloadCandidateHiringAudio,
  downloadCandidateHiringZip,
  fetchCandidateHiringAssignment,
  patchCandidateHiringSubmission,
  submitCandidateHiringAssignment,
} from "@/lib/api";

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

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
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const readOnly = detail?.status === "SUBMITTED" || detail?.status === "EVALUATED";
  const timeExpired = secondsRemaining !== null && secondsRemaining <= 0 && !readOnly;
  const editingDisabled = readOnly || timeExpired;
  const transcriptWordCount = draftTranscript.trim() ? draftTranscript.trim().split(/\s+/).length : 0;
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
  const submitSummary = detail?.items.map((item) => {
    const submission = detail.submissions.find((candidate) => candidate.item_id === item.id);
    return {
      item,
      readiness: submission ? readinessForSubmission(submission) : submissionReady(submission, detail.assessment.metadata_schema),
    };
  }) ?? [];

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
    if (!accessToken || !selectedItem) return;
    let cancelled = false;
    setAudioBusy(true);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    void downloadCandidateHiringAudio(accessToken, assignmentId, selectedItem.id)
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
  }, [accessToken, assignmentId, selectedItem?.id]);

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

  async function downloadAudio(item: HiringAssessmentItem) {
    if (!accessToken) return;
    setBusy(true);
    try {
      const response = await downloadCandidateHiringAudio(accessToken, assignmentId, item.id);
      saveBlob(response.blob, response.filename);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Audio download failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadAll() {
    if (!accessToken) return;
    setBusy(true);
    try {
      const response = await downloadCandidateHiringZip(accessToken, assignmentId);
      saveBlob(response.blob, response.filename);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "ZIP download failed");
    } finally {
      setBusy(false);
    }
  }

  function markDirty() {
    setDraftDirty(true);
    setSaveState("unsaved");
    setMessage(null);
  }

  async function saveSubmission(manual = true): Promise<boolean> {
    if (!accessToken || !selectedSubmission || editingDisabled) return false;
    if (!manual && !draftDirty) return true;
    if (manual) setBusy(true);
    setSaveState("saving");
    try {
      const updated = await patchCandidateHiringSubmission(accessToken, selectedSubmission.id, {
        version: selectedSubmission.version,
        final_transcript: draftTranscript,
        pii_text: draftPIIText,
        pii_entries: cleanPIIEntries(draftPIIEntries),
        notes: draftNotes,
        metadata_values: draftMetadata,
        pii_reviewed: piiReviewed,
      });
      setDetail(updated);
      setDraftDirty(false);
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      if (manual) setMessage("Saved");
      setError(null);
      return true;
    } catch (err) {
      setSaveState("failed");
      setError(err instanceof APIError ? err.message : "Save failed");
      return false;
    } finally {
      if (manual) setBusy(false);
    }
  }

  async function selectItem(itemId: string) {
    if (itemId === selectedItemId) return;
    if (draftDirty && !editingDisabled) {
      const saved = await saveSubmission(false);
      if (!saved) return;
    }
    setSelectedItemId(itemId);
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
    <section className="animate-fade-in space-y-4">
      <div
        aria-label="Hiring test watermark"
        className="pointer-events-none rounded-xl border border-[#e6dcf2] bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#514a70]"
      >
        Hiring test | {user?.email ?? "signed-in candidate"} | {detail.assessment.title}
      </div>

      <div className="rounded-[1.35rem] border border-[#e4e7ee] bg-[linear-gradient(135deg,#ffffff_0%,#f6f8fb_100%)] shadow-[0_22px_48px_-40px_rgba(15,23,42,0.45)]">
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6b7280]">Candidate Workspace</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="oa-title text-xl font-semibold">{detail.assessment.title}</h1>
                <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2.5 py-1 text-xs font-semibold text-[#1d4ed8]">
                  {detail.status}
                </span>
              </div>
              {detail.assessment.instructions ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5b79]">{detail.assessment.instructions}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={downloadAll} disabled={busy || editingDisabled} className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50">
                Download All
              </button>
              <button type="button" onClick={prepareSubmit} disabled={busy || editingDisabled || !allReady} className="oa-btn-primary px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                {readOnly ? "Submitted" : "Submit Test"}
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              Due {formatDeadline(detail.assessment.due_at, detail.assessment.due_date)}
            </span>
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              Deadline {detail.submission_deadline_at ? formatDateTime(detail.submission_deadline_at) : "No deadline"}
            </span>
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {completedItems}/{detail.items.length} audio completed
            </span>
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {transcriptWordCount} words in current transcript
            </span>
            <span className={`rounded-full border px-3 py-1 text-xs font-medium ${timeExpired ? "border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]" : "border-[#e2e8f0] bg-white text-[#374151]"}`}>
              Time {formatDuration(secondsRemaining)}
            </span>
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {saveState === "saving" ? "Saving..." : saveState === "failed" ? "Autosave failed" : saveState === "unsaved" ? "Unsaved edits" : `Saved ${formatDateTime(lastSavedAt)}`}
            </span>
          </div>
        </div>
      </div>

      {error ? <p className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">{error}</p> : null}
      {message ? <p className="rounded-lg border border-[#c8e6d4] bg-[#f0fbf4] px-3 py-2 text-sm text-[#236140]">{message}</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-2">
          {detail.items.map((item) => {
            const submission = detail.submissions.find((candidate) => candidate.item_id === item.id);
            const checklist = submissionReady(submission, detail.assessment.metadata_schema);
            const ready = checklist.transcript && checklist.pii && checklist.metadata;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void selectItem(item.id)}
                className={`w-full rounded-xl border p-3 text-left text-sm transition ${
                  item.id === selectedItemId ? "border-[#b99bde] bg-white" : "border-[#eee5f8] bg-[#fbf8ff]"
                }`}
              >
                <span className="block font-semibold text-[#1f1b3f]">{item.original_filename}</span>
                <span className={`mt-1 inline-block text-xs ${ready ? "text-[#236140]" : "text-[#8a5b1e]"}`}>
                  {ready ? "Ready" : "Needs work"}
                </span>
                <span className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
                  <span className={checklist.transcript ? "text-[#236140]" : "text-[#8a5b1e]"}>Transcript</span>
                  <span className={checklist.pii ? "text-[#236140]" : "text-[#8a5b1e]"}>PII</span>
                  <span className={checklist.metadata ? "text-[#236140]" : "text-[#8a5b1e]"}>Metadata</span>
                </span>
              </button>
            );
          })}
        </aside>

        {selectedItem && selectedSubmission ? (
          <div className="space-y-4">
            <div className="oa-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="oa-title text-sm font-semibold uppercase tracking-[0.1em] text-[#4b5563]">Audio</h2>
                  <p className="mt-1 text-sm font-semibold text-[#1f1b3f]">{selectedItem.original_filename}</p>
                </div>
                <button type="button" onClick={() => void downloadAudio(selectedItem)} disabled={busy || editingDisabled} className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50">
                  Download
                </button>
              </div>
              <div className="mb-3 grid gap-2 text-xs text-[#4b5563] sm:grid-cols-3">
                <ChecklistPill label="Transcript" ready={currentReadiness.transcript} />
                <ChecklistPill label="PII reviewed" ready={currentReadiness.pii} />
                <ChecklistPill label="Metadata" ready={currentReadiness.metadata} />
              </div>
              {audioBusy ? (
                <div className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-4 text-sm text-[#5f5b79]">Loading audio...</div>
              ) : (
                <AudioWaveformPlayer audioUrl={audioUrl} allowDownloadControls />
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]">
              <div className="space-y-4">
                <div className="oa-card p-4 sm:p-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="oa-title text-sm font-semibold" htmlFor="candidate-transcript">
                      Final Transcript
                    </label>
                    <span className="text-xs text-[#6b7280]">Type the transcript manually</span>
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
                    rows={14}
                    className="oa-textarea min-h-[460px] bg-white font-mono text-[15px] disabled:bg-[#f5f2f8]"
                    placeholder="Start typing the transcript from the audio..."
                  />
                </div>

                <div className="oa-card p-4">
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
                    className="oa-textarea mt-2 min-h-[88px] disabled:bg-[#f5f2f8]"
                    placeholder="Optional context about unclear speech, uncertainty, or assumptions."
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="oa-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="oa-title text-base font-semibold">PII Answer</h3>
                    <label className="flex items-center gap-2 text-xs text-[#5f5b79]">
                      <input
                        type="checkbox"
                        checked={piiReviewed}
                        disabled={editingDisabled}
                        onChange={(event) => {
                          setPiiReviewed(event.target.checked);
                          markDirty();
                        }}
                      />
                      Reviewed
                    </label>
                  </div>
                  <div className="mt-3 space-y-2">
                    {draftPIIEntries.map((entry, index) => (
                      <div key={index} className="rounded-lg border border-[#e5dbf1] bg-[#fbf8ff] p-2">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <input
                            className="oa-input"
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
                            className="oa-input"
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
                            className="oa-input"
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
                            className="oa-input"
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
                      className="oa-btn-secondary px-3 py-2 text-sm disabled:opacity-50"
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
                    className="oa-textarea mt-3 min-h-[100px] disabled:bg-[#f5f2f8]"
                    placeholder="Optional: write None or add extra PII notes."
                  />
                </div>

                <div className="oa-card p-4">
                  <h3 className="oa-title text-base font-semibold">Metadata</h3>
                  <div className="mt-3 space-y-3">
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

            <div className="sticky bottom-8 z-10 flex justify-end">
              <button type="button" onClick={() => void saveSubmission(true)} disabled={busy || editingDisabled} className="oa-btn-primary px-5 py-2.5 text-sm font-semibold disabled:opacity-50">
                Save Item
              </button>
            </div>
          </div>
        ) : null}
      </div>
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

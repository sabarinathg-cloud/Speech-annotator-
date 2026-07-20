"use client";

import type {
  AudioAlignmentWord,
  AudioMaskInterval,
  AudioMaskMode,
  PIIAnnotation,
  TaskAudioGroup,
  TaskDetail,
  TaskStatus,
} from "@outcomes/shared-types";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import {
  AnnotatorGuidedTour,
  type AnnotatorGuidedTourActionStatus,
  type AnnotatorGuidedTourMilestone,
  type AnnotatorGuidedTourStep,
} from "@/components/annotator-guided-tour";
import { AudioWaveformPlayer } from "@/components/audio-waveform-player";
import { ConflictModal, type ConflictMergeResolution } from "@/components/conflict-modal";
import { CoreMetadataState, MetadataEditor } from "@/components/metadata-editor";
import { PIIAnnotator } from "@/components/pii-annotator";
import { SaveIndicator } from "@/components/save-indicator";
import { StatusBadge } from "@/components/status-badge";
import { TranscriptComparison } from "@/components/transcript-comparison";
import { resolveBackendOrigin } from "@/lib/api-config";
import { validateAnnotationText } from "@/lib/text-validation";
import {
  APIError,
  detectTaskPII,
  fetchAudioURL,
  fetchPIILabels,
  fetchTask,
  fetchTaskAudioGroup,
  generateTaskAlignment,
  maskTaskPIIAudio,
  patchTaskCombined,
  startTask,
} from "@/lib/api";
import { detectPIIAnnotations, sanitizePIIAnnotations } from "@/lib/pii";
import {
  fallbackPIILabels,
  toPIILabelOptions,
  type PIILabelOption,
} from "@/lib/pii-labels";

const audioMaskModeOptions: Array<{ value: AudioMaskMode; label: string }> = [
  { value: "silence", label: "Silence" },
  { value: "beep", label: "Beep" },
];

type InspectorPanelKey = "compare" | "metadata" | "pii" | "notes";

const inspectorTabs: Array<{ key: InspectorPanelKey; label: string }> = [
  { key: "compare", label: "Compare" },
  { key: "metadata", label: "Metadata" },
  { key: "pii", label: "PII" },
  { key: "notes", label: "Notes" },
];

const annotatorTourSteps: AnnotatorGuidedTourStep[] = [
  {
    id: "assignment-start",
    modes: ["quick", "full"],
    targetId: "task-overview",
    title: "Start with the assignment",
    body: "When you open an assigned task, this is the workspace you use to finish it. If the task was Not Started, it moves into In Progress so your ownership is clear.",
    checklist: [
      "Confirm the task ID and status before editing.",
      "Check that the audio file path matches the work you expected.",
    ],
  },
  {
    id: "task-context",
    targetId: "task-context",
    title: "Read the task context",
    body: "These chips give you the quick facts: number of ASR sources, current PII count, assignee, last tagger, and audio duration.",
    checklist: [
      "Use the ASR count to know how much comparison evidence exists.",
      "Use duration to plan how long the task may take.",
    ],
  },
  {
    id: "top-actions",
    targetId: "top-actions",
    title: "Understand the top actions",
    body: "Previous moves to the earlier task, Save Now saves all current edits, and the final completion button appears only after the required checkpoints are saved.",
    checklist: [
      "Use Save Now before leaving the screen.",
      "Wait for Save and Next or Save and Finish before completing the task.",
    ],
  },
  {
    id: "save-state",
    targetId: "save-state",
    title: "Watch save status",
    body: "This line tells you whether edits are pending, saved, or blocked by an error. The app autosaves, but this status is your confidence check.",
    checklist: [
      "Do not complete a task while important edits still show as pending.",
      "If a section fails, fix the issue and save again.",
    ],
  },
  {
    id: "draft-safety",
    targetId: "save-state",
    title: "Know how draft recovery works",
    body: "If the browser refreshes or closes with unsaved work, the workspace can show a local draft banner. Restore it when it contains your latest edits, or discard it when the saved server version is correct.",
  },
  {
    id: "completion-checkpoints",
    targetId: "completion-checkpoints",
    title: "Use the completion checkpoints",
    body: "The task cannot reach Completed until Transcript, PII, Audio Masking, and Metadata are all saved. If you edit one of these areas again, its checkpoint returns to pending.",
    checklist: [
      "Save Transcript after transcript corrections.",
      "Save PII after detecting or manually changing entities.",
      "Save Audio Masking after reviewing masked audio.",
      "Save Metadata after checking task metadata.",
    ],
  },
  {
    id: "keyboard-shortcuts",
    modes: ["quick", "full"],
    targetId: "keyboard-shortcuts",
    title: "Use keyboard shortcuts",
    body: "Shortcuts reduce repetitive clicks while you listen and correct. They work best once you are comfortable with the workspace layout.",
    checklist: [
      "Space plays or pauses audio.",
      "J and L move backward or forward by 5 seconds.",
      "Ctrl + S saves, Ctrl + Enter completes after checkpoints are saved.",
      "Alt + M tags selected transcript text as PII.",
    ],
  },
  {
    id: "audio",
    modes: ["quick", "full"],
    targetId: "audio-workspace",
    title: "Listen to the audio",
    body: "Start by listening to the original audio. Use the waveform to replay uncertain parts and compare what you hear with the final transcript.",
    checklist: [
      "Pause often when the speech is unclear.",
      "Use the duration and waveform position to stay oriented.",
    ],
  },
  {
    id: "transcript",
    modes: ["quick", "full"],
    targetId: "final-transcript",
    title: "Correct the final transcript",
    body: "This is the main transcript that will be exported. Correct wrong words, missed words, spelling, punctuation, and formatting while preserving the meaning of the speech.",
    requiredAction: {
      id: "transcript-reviewed",
      label: "Edit or confirm the final transcript",
      hint: "Type a correction or save the Transcript checkpoint to unlock the next step.",
    },
    actionId: "focus-transcript",
    actionLabel: "Focus transcript",
    checklist: [
      "Keep only the corrected final version here.",
      "After meaningful edits, Save Transcript before completing.",
    ],
  },
  {
    id: "word-check",
    targetId: "word-audio-check",
    title: "Verify difficult words",
    body: "Run Align Words when you need word-level checking. After alignment, click a word to hear that exact part of the original audio.",
    checklist: [
      "Use this for names, numbers, addresses, and unclear phrases.",
      "Refresh alignment after large transcript edits.",
    ],
  },
  {
    id: "compare",
    targetId: "inspector-compare",
    inspectorPanel: "compare",
    title: "Compare ASR variants",
    body: "The Compare tab shows imported ASR transcripts. Disagreements are highlighted so you can spot risky words, and you can copy a better variant into the final transcript when useful.",
    checklist: [
      "Use ASR comparison as evidence, not as the final truth.",
      "Always confirm doubtful words against the audio.",
    ],
  },
  {
    id: "metadata",
    targetId: "inspector-metadata",
    inspectorPanel: "metadata",
    title: "Verify metadata",
    body: "The Metadata tab holds fields such as speaker gender, speaker role, language, channel, duration, and custom import columns. Correct only what is wrong or missing.",
    checklist: [
      "Save Metadata after edits.",
    ],
  },
  {
    id: "pii-detect",
    modes: ["quick", "full"],
    targetId: "inspector-pii",
    inspectorPanel: "pii",
    title: "Detect and review PII",
    body: "Open the PII tab and run detection. The system highlights likely personal information, but you still decide what is correct.",
    requiredAction: {
      id: "pii-detection-reviewed",
      label: "Run PII detection or save PII review",
      hint: "Run detection after the transcript is ready, then review every entity before continuing.",
    },
    actionId: "run-pii-detection",
    actionLabel: "Run PII detection",
    checklist: [
      "Review every detected entity.",
      "Remove false positives.",
      "Change labels when a detected type is wrong.",
    ],
  },
  {
    id: "pii-manual",
    modes: ["quick", "full"],
    targetId: "inspector-pii",
    inspectorPanel: "pii",
    title: "Add or fix PII manually",
    body: "Select the exact text span, choose the right PII label, and add it. Use Selection replaces a saved span with your current selection, Apply All tags repeated matching values, and Remove deletes incorrect entities.",
    checklist: [
      "Use Alt + M after selecting text in the final transcript for quick tagging.",
      "Check overlap warnings before saving PII.",
      "Save PII after manual changes.",
    ],
  },
  {
    id: "mistake-recovery",
    targetId: "inspector-pii",
    inspectorPanel: "pii",
    title: "Fix tagging mistakes quickly",
    body: "If a tag is wrong, use Remove, change the label dropdown, or select a better span and use Use Selection. Apply All is only for repeated values that truly need the same label.",
    checklist: [
      "Remove false positives before saving PII.",
      "Use Selection when the detected span is too short or too long.",
      "Use Apply All only after checking the repeated value is the same kind of PII.",
    ],
  },
  {
    id: "mask-controls",
    modes: ["quick", "full"],
    targetId: "audio-mask-controls",
    title: "Create masked audio",
    body: "Choose Silence or Beep, align words, then mask PII. Saving PII can also run alignment and masking automatically when PII exists.",
    requiredAction: {
      id: "masked-audio-reviewed",
      label: "Create or confirm masked audio",
      hint: "If PII exists, generate and review the masked preview. If no PII exists, this step is automatically ready.",
    },
    actionId: "create-masked-audio",
    actionLabel: "Create masked audio",
    checklist: [
      "Use Silence when the requirement is quiet redaction.",
      "Use Beep when reviewers need an audible redaction cue.",
      "If the transcript changed, refresh alignment before trusting masks.",
    ],
  },
  {
    id: "mask-review",
    modes: ["quick", "full"],
    targetId: "audio-workspace",
    title: "Review masks and preview audio",
    body: "After masking, PII Mask Windows show the accepted timing spans and the Masked Audio Preview lets you listen to the redacted result. Adjust start and end times only when the mask misses or over-covers speech.",
    checklist: [
      "Make sure every PII span is covered in the masked preview.",
      "If you adjust timing, update the mask and save Audio Masking.",
    ],
  },
  {
    id: "notes",
    targetId: "inspector-notes",
    inspectorPanel: "notes",
    title: "Leave clear notes",
    body: "Use Notes for handoff context, reviewer concerns, or uncertainty that cannot be solved from the audio. Keep notes short and specific.",
    checklist: [
      "Mention timestamps when something is ambiguous.",
      "Avoid notes for routine edits that are already visible.",
    ],
  },
  {
    id: "save-sections",
    modes: ["quick", "full"],
    targetId: "completion-checkpoints",
    title: "Save each required section",
    body: "Before completing, make all four checkpoint cards say Saved. A clean order is Save Transcript, Save PII, Save Audio Masking, then Save Metadata.",
    requiredAction: {
      id: "all-checkpoints-saved",
      label: "Save Transcript, PII, Audio Masking, and Metadata",
      hint: "The completion button appears only after all four checkpoint cards are saved.",
    },
    actionId: "save-pending-checkpoints",
    actionLabel: "Save pending checkpoints",
    checklist: [
      "If there is no PII, still save the PII checkpoint to confirm review.",
      "If there are PII tags, confirm masked audio before saving Audio Masking.",
    ],
  },
  {
    id: "complete",
    modes: ["quick", "full"],
    targetId: "top-actions",
    title: "Complete the task",
    body: "When every checkpoint is saved, Save and Next or Save and Finish appears. Click it to save all edits, move the task to Completed, and open the next assigned task when one exists.",
    requiredAction: {
      id: "ready-to-complete",
      label: "All checkpoints saved",
      hint: "Complete becomes available when every required section is saved.",
    },
    actionId: "complete-task",
    actionLabel: "Complete task",
    checklist: [
      "Completed means your transcript, PII, masking, and metadata checks are done.",
      "If the button is hidden, return to the checkpoint cards and save the pending section.",
    ],
  },
];

type SaveState = "idle" | "unsaved" | "saving" | "saved" | "error";
type SaveSectionKey = "transcript" | "metadata" | "notes" | "pii";
type VerificationSectionKey = "transcript" | "pii" | "masking" | "metadata";

const saveSectionLabels: Record<SaveSectionKey, string> = {
  transcript: "Transcript",
  metadata: "Metadata",
  notes: "Notes",
  pii: "PII",
};

const verificationSectionLabels: Record<VerificationSectionKey, string> = {
  transcript: "Transcript",
  pii: "PII",
  masking: "Audio Masking",
  metadata: "Metadata",
};

const emptyVerificationState: Record<VerificationSectionKey, boolean> = {
  transcript: false,
  pii: false,
  masking: false,
  metadata: false,
};

const workflowSavedStatuses: TaskStatus[] = ["Completed", "Needs Review", "Reviewed", "Approved", "Rejected"];

const LOCAL_DRAFT_SCHEMA_VERSION = 1;
const MAX_AUTOSAVE_RETRY_DELAY_MS = 30000;

interface LocalTaskDraft {
  schema_version: number;
  task_id: string;
  user_id: string | null;
  base_version: number;
  base_updated_at: string;
  saved_at: string;
  final_transcript: string;
  notes: string;
  status: TaskStatus;
  metadata: CoreMetadataState;
  custom_metadata: Record<string, string>;
  pii_annotations: PIIAnnotation[];
}

function formatDurationLabel(durationSeconds: string | null | undefined): string {
  if (!durationSeconds || Number.isNaN(Number(durationSeconds))) {
    return "—";
  }
  const seconds = Number(durationSeconds);
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function normalizeComparisonWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
}

function countWords(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  words.forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1));
  return counts;
}

function diffWordCounts(expectedText: string, actualText: string): {
  similarityPercent: number | null;
  missingWords: string[];
  extraWords: string[];
  referenceWordCount: number;
  actualWordCount: number;
} {
  const expectedWords = normalizeComparisonWords(expectedText);
  const actualWords = normalizeComparisonWords(actualText);
  if (expectedWords.length === 0 && actualWords.length === 0) {
    return {
      similarityPercent: null,
      missingWords: [],
      extraWords: [],
      referenceWordCount: 0,
      actualWordCount: 0,
    };
  }

  const expectedCounts = countWords(expectedWords);
  const actualCounts = countWords(actualWords);
  const missingWords: string[] = [];
  const extraWords: string[] = [];
  let matched = 0;

  expectedCounts.forEach((expectedCount, word) => {
    const actualCount = actualCounts.get(word) ?? 0;
    matched += Math.min(expectedCount, actualCount);
    for (let index = 0; index < Math.max(0, expectedCount - actualCount); index += 1) {
      missingWords.push(word);
    }
  });

  actualCounts.forEach((actualCount, word) => {
    const expectedCount = expectedCounts.get(word) ?? 0;
    for (let index = 0; index < Math.max(0, actualCount - expectedCount); index += 1) {
      extraWords.push(word);
    }
  });

  return {
    similarityPercent: Math.round((matched / Math.max(expectedWords.length, actualWords.length, 1)) * 100),
    missingWords,
    extraWords,
    referenceWordCount: expectedWords.length,
    actualWordCount: actualWords.length,
  };
}

function formatTimestampSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "--";
  }
  return seconds.toFixed(3);
}

function roundTimestampSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function buildDraftKey(taskId: string, userId: string | null | undefined): string {
  return `outcomes-ai:speech-annotator:draft:${userId ?? "anonymous"}:${taskId}`;
}

function deriveSectionSaveState(
  taskStatus: TaskStatus,
  piiAnnotations: PIIAnnotation[],
  maskIntervals: AudioMaskInterval[]
): Record<VerificationSectionKey, boolean> {
  if (!workflowSavedStatuses.includes(taskStatus)) {
    return { ...emptyVerificationState };
  }
  const audioMaskingSaved = piiAnnotations.length === 0 || maskIntervals.length > 0;
  return {
    transcript: true,
    pii: true,
    masking: audioMaskingSaved,
    metadata: true,
  };
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function parseLocalDraft(rawValue: string | null): LocalTaskDraft | null {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue) as Partial<LocalTaskDraft>;
    if (
      parsed.schema_version !== LOCAL_DRAFT_SCHEMA_VERSION ||
      typeof parsed.task_id !== "string" ||
      typeof parsed.base_version !== "number" ||
      typeof parsed.base_updated_at !== "string" ||
      typeof parsed.saved_at !== "string" ||
      typeof parsed.final_transcript !== "string" ||
      typeof parsed.notes !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.metadata !== "object" ||
      parsed.metadata === null ||
      typeof parsed.custom_metadata !== "object" ||
      parsed.custom_metadata === null
    ) {
      return null;
    }
    return {
      schema_version: parsed.schema_version,
      task_id: parsed.task_id,
      user_id: typeof parsed.user_id === "string" ? parsed.user_id : null,
      base_version: parsed.base_version,
      base_updated_at: parsed.base_updated_at,
      saved_at: parsed.saved_at,
      final_transcript: parsed.final_transcript,
      notes: parsed.notes,
      status: parsed.status as TaskStatus,
      metadata: {
        speaker_gender: String((parsed.metadata as CoreMetadataState).speaker_gender ?? ""),
        speaker_role: String((parsed.metadata as CoreMetadataState).speaker_role ?? ""),
        language: String((parsed.metadata as CoreMetadataState).language ?? ""),
        channel: String((parsed.metadata as CoreMetadataState).channel ?? ""),
        duration_seconds: String((parsed.metadata as CoreMetadataState).duration_seconds ?? "")
      },
      custom_metadata: Object.fromEntries(
        Object.entries(parsed.custom_metadata as Record<string, unknown>).map(([key, value]) => [
          key,
          String(value ?? "")
        ])
      ),
      pii_annotations: Array.isArray(parsed.pii_annotations)
        ? (parsed.pii_annotations as unknown[]).map((entry) => {
            const item =
              typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
            return {
              id: String(item.id ?? ""),
              label: String(item.label ?? "OTHER"),
              start: Number(item.start ?? 0),
              end: Number(item.end ?? 0),
              value: String(item.value ?? ""),
              source: item.source !== undefined && item.source !== null ? String(item.source) : null,
              confidence:
                item.confidence !== undefined && item.confidence !== null ? Number(item.confidence) : null,
            };
          })
        : [],
    };
  } catch {
    return null;
  }
}

export default function TaskWorkspacePage() {
  const { accessToken, user, activeOrganization } = useAuth();
  const params = useParams<{ taskId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskIdParam = params.taskId;
  const taskId = Array.isArray(taskIdParam) ? (taskIdParam[0] ?? "") : (taskIdParam ?? "");
  const requestedTour = searchParams.get("tour") === "1";
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioGroup, setAudioGroup] = useState<TaskAudioGroup | null>(null);
  const [fullAudioUrl, setFullAudioUrl] = useState<string | null>(null);
  const [fullReviewTranscript, setFullReviewTranscript] = useState("");
  const [fullReviewTouched, setFullReviewTouched] = useState(false);
  const [fullReviewOpen, setFullReviewOpen] = useState(false);
  const [version, setVersion] = useState(1);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<TaskStatus>("Not Started");
  const [metadata, setMetadata] = useState<CoreMetadataState>({
    speaker_gender: "",
    speaker_role: "",
    language: "",
    channel: "",
    duration_seconds: ""
  });
  const [customMetadata, setCustomMetadata] = useState<Record<string, string>>({});
  const [piiAnnotations, setPiiAnnotations] = useState<PIIAnnotation[]>([]);
  const [originalMetadata, setOriginalMetadata] = useState<CoreMetadataState>({
    speaker_gender: "",
    speaker_role: "",
    language: "",
    channel: "",
    duration_seconds: ""
  });
  const [originalCustomMetadata, setOriginalCustomMetadata] = useState<Record<string, string>>({});
  const [originalPIIAnnotations, setOriginalPIIAnnotations] = useState<PIIAnnotation[]>([]);
  const [originalTranscript, setOriginalTranscript] = useState("");
  const [originalNotes, setOriginalNotes] = useState("");
  const [originalStatus, setOriginalStatus] = useState<TaskStatus>("Not Started");
  const [transcriptDirty, setTranscriptDirty] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [statusDirty, setStatusDirty] = useState(false);
  const [piiDirty, setPiiDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({});
  const [verifiedSections, setVerifiedSections] =
    useState<Record<VerificationSectionKey, boolean>>(emptyVerificationState);
  const [loading, setLoading] = useState(true);
  const [piiLabelOptions, setPiiLabelOptions] = useState<PIILabelOption[]>(fallbackPIILabels);
  const [piiDetectionBusy, setPiiDetectionBusy] = useState(false);
  const [piiDetectionMessage, setPiiDetectionMessage] = useState<string | null>(null);
  const [piiDetectionReviewedTranscript, setPiiDetectionReviewedTranscript] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    open: boolean;
    serverTask: TaskDetail | null;
    conflictingFields: string[];
  }>({
    open: false,
    serverTask: null,
    conflictingFields: []
  });
  const [draftState, setDraftState] = useState<{
    mode: "none" | "restored" | "pending";
    savedAt: string | null;
  }>({
    mode: "none",
    savedAt: null
  });
  const savingRef = useRef(false);
  const versionRef = useRef(1);
  const transcriptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [transcriptSelection, setTranscriptSelection] = useState<{
    start: number;
    end: number;
    value: string;
  } | null>(null);
  const [activeInspectorPanel, setActiveInspectorPanel] = useState<InspectorPanelKey>("compare");
  const [selectionLabel, setSelectionLabel] = useState<string>("OTHER");
  const hasUnsavedChangesRef = useRef(false);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const saveAllRef = useRef<(versionOverride?: number) => Promise<boolean>>(async () => false);
  const wordAudioRef = useRef<HTMLAudioElement | null>(null);
  const wordStopAtRef = useRef<number | null>(null);
  const wordStopTimerRef = useRef<number | null>(null);
  const piiAutoDetectionTranscriptRef = useRef<string | null>(null);
  const piiAnnotationsRef = useRef<PIIAnnotation[]>([]);
  const [alignmentWords, setAlignmentWords] = useState<AudioAlignmentWord[]>([]);
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [alignmentMessage, setAlignmentMessage] = useState<string | null>(null);
  const [maskedAudioUrl, setMaskedAudioUrl] = useState<string | null>(null);
  const [maskedIntervals, setMaskedIntervals] = useState<AudioMaskInterval[]>([]);
  const [acceptedMaskIntervals, setAcceptedMaskIntervals] = useState<AudioMaskInterval[]>([]);
  const [alignmentMaskIntervals, setAlignmentMaskIntervals] = useState<AudioMaskInterval[]>([]);
  const [audioMaskMode, setAudioMaskMode] = useState<AudioMaskMode>("silence");
  const [maskedAudioMode, setMaskedAudioMode] = useState<AudioMaskMode | null>(null);
  const [maskIntervalsDirty, setMaskIntervalsDirty] = useState(false);
  const [maskingBusy, setMaskingBusy] = useState(false);
  const [autoMaskingBusy, setAutoMaskingBusy] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);

  const metadataEnabled = activeOrganization?.settings.metadata_enabled !== false;
  const piiEnabled = activeOrganization?.settings.pii_enabled !== false;
  const audioMaskingEnabled = piiEnabled && activeOrganization?.settings.audio_masking_enabled !== false;
  const enabledVerificationSections = useMemo<VerificationSectionKey[]>(
    () => [
      "transcript",
      ...(piiEnabled ? (["pii"] as VerificationSectionKey[]) : []),
      ...(audioMaskingEnabled ? (["masking"] as VerificationSectionKey[]) : []),
      ...(metadataEnabled ? (["metadata"] as VerificationSectionKey[]) : []),
    ],
    [audioMaskingEnabled, metadataEnabled, piiEnabled]
  );
  const transcriptDependentSections = useMemo<VerificationSectionKey[]>(
    () => ["transcript", ...(piiEnabled ? (["pii"] as VerificationSectionKey[]) : []), ...(audioMaskingEnabled ? (["masking"] as VerificationSectionKey[]) : [])],
    [audioMaskingEnabled, piiEnabled]
  );
  const visibleInspectorTabs = useMemo(
    () =>
      inspectorTabs.filter((tab) => {
        if (tab.key === "metadata") return metadataEnabled;
        if (tab.key === "pii") return piiEnabled;
        return true;
      }),
    [metadataEnabled, piiEnabled]
  );
  const visibleTourSteps = useMemo(
    () =>
      annotatorTourSteps.filter((step) => {
        if (step.inspectorPanel === "metadata" || step.id === "metadata") return metadataEnabled;
        if (step.inspectorPanel === "pii" || step.id.startsWith("pii-")) return piiEnabled;
        if (step.id.startsWith("mask-") || step.targetId === "audio-mask-controls") return audioMaskingEnabled;
        return true;
      }),
    [audioMaskingEnabled, metadataEnabled, piiEnabled]
  );
  const hasUnsavedChanges =
    transcriptDirty || notesDirty || statusDirty || (metadataEnabled && metadataDirty) || (piiEnabled && piiDirty);
  const allSectionsVerified = enabledVerificationSections.every(
    (key) => verifiedSections[key]
  );
  const maskingApprovalBlocked = audioMaskingEnabled && piiAnnotations.length > 0 && (!maskedAudioUrl || maskIntervalsDirty);
  const draftStorageKey = taskId ? buildDraftKey(taskId, user?.id) : null;
  const backendBase = useMemo(() => resolveBackendOrigin(), []);
  const saveSectionStatuses = (Object.entries(saveSectionLabels) as Array<[SaveSectionKey, string]>).filter(
    ([key]) => (key === "metadata" ? metadataEnabled : key === "pii" ? piiEnabled : true)
  ).map(
    ([key, label]) => {
      const isDirty =
        key === "transcript"
          ? transcriptDirty
          : key === "metadata"
            ? metadataDirty
            : key === "notes"
              ? notesDirty
              : piiDirty;
      const failedMessage = sectionErrors[key];
      return {
        key,
        label,
        failedMessage,
        state: failedMessage ? "failed" : isDirty ? "pending" : "saved",
      };
    }
  );
  const visibleSaveSectionStatuses = saveSectionStatuses.filter((section) => section.state !== "saved");
  const assembledSegmentTranscript = useMemo(() => {
    if (!audioGroup) return finalTranscript.trim();
    return audioGroup.chunks
      .map((chunk) => (chunk.task_id === task?.id ? finalTranscript : chunk.final_transcript ?? "").trim())
      .filter(Boolean)
      .join("\n");
  }, [audioGroup, finalTranscript, task?.id]);
  const fullReviewComparison = useMemo(
    () => diffWordCounts(assembledSegmentTranscript, fullReviewTranscript),
    [assembledSegmentTranscript, fullReviewTranscript]
  );
  const fullReviewHasConflict =
    Boolean(fullReviewTranscript.trim() || assembledSegmentTranscript.trim()) &&
    (fullReviewComparison.missingWords.length > 0 || fullReviewComparison.extraWords.length > 0);
  const guidedTourMilestones = useMemo<AnnotatorGuidedTourMilestone[]>(
    () => {
      const workflowAlreadyComplete = workflowSavedStatuses.includes(status);
      return [
        {
          id: "assignment-start",
          label: "Task opened",
          complete: Boolean(task) && status !== "Not Started",
        },
        {
          id: "transcript",
          label: "Transcript reviewed",
          complete: workflowAlreadyComplete || verifiedSections.transcript || Boolean(finalTranscript.trim()),
        },
        {
          id: "pii-detect",
          label: "PII reviewed",
          complete:
            !piiEnabled ||
            workflowAlreadyComplete ||
            verifiedSections.pii ||
            (Boolean(finalTranscript.trim()) && piiDetectionReviewedTranscript === finalTranscript),
        },
        {
          id: "mask-controls",
          label: "Masked audio checked",
          complete:
            !audioMaskingEnabled ||
            workflowAlreadyComplete ||
            piiAnnotations.length === 0 ||
            Boolean(maskedAudioUrl && !maskIntervalsDirty),
        },
        {
          id: "save-sections",
          label: "Checkpoints saved",
          complete: workflowAlreadyComplete || allSectionsVerified,
        },
        {
          id: "complete",
          label: "Task completed",
          complete: workflowAlreadyComplete,
        },
      ];
    },
    [
      allSectionsVerified,
      finalTranscript,
      maskIntervalsDirty,
      maskedAudioUrl,
      piiAnnotations.length,
      piiDetectionReviewedTranscript,
      piiEnabled,
      status,
      task,
      audioMaskingEnabled,
      verifiedSections.pii,
      verifiedSections.transcript,
    ]
  );
  const guidedTourActionStatus = useMemo<Record<string, AnnotatorGuidedTourActionStatus>>(
    () => {
      const workflowAlreadyComplete = workflowSavedStatuses.includes(status);
      const transcriptHasContent = Boolean(finalTranscript.trim());
      const transcriptReady = workflowAlreadyComplete || verifiedSections.transcript || transcriptHasContent;
      const piiDetectionReady =
        !piiEnabled ||
        workflowAlreadyComplete ||
        verifiedSections.pii ||
        (transcriptHasContent && piiDetectionReviewedTranscript === finalTranscript);
      const maskedAudioReady =
        !audioMaskingEnabled ||
        workflowAlreadyComplete ||
        piiAnnotations.length === 0 ||
        Boolean(maskedAudioUrl && !maskIntervalsDirty);
      const checkpointsReady = workflowAlreadyComplete || allSectionsVerified;

      return {
        "transcript-reviewed": {
          complete: transcriptReady,
          hint: transcriptReady
            ? "Transcript has content or the checkpoint is already saved."
            : "Add or confirm transcript text before continuing.",
        },
        "pii-detection-reviewed": {
          complete: piiDetectionReady,
          disabled: !transcriptHasContent || piiDetectionBusy,
          hint: !transcriptHasContent
            ? "Add transcript text before running PII detection."
            : piiDetectionReady
              ? "PII detection has run for the current transcript, or the PII checkpoint is saved."
              : "Run PII detection, then remove false positives and fix labels before continuing.",
        },
        "masked-audio-reviewed": {
          complete: maskedAudioReady,
          disabled: piiAnnotations.length === 0 || alignmentBusy || maskingBusy || autoMaskingBusy,
          hint:
            piiAnnotations.length === 0
              ? "No PII is currently present, so no masked preview is required."
              : maskedAudioReady
                ? "Masked audio is generated and ready for review."
                : "Generate masked audio and listen to the preview before saving Audio Masking.",
        },
        "all-checkpoints-saved": {
          complete: checkpointsReady,
          disabled: saveState === "saving" || autoMaskingBusy,
          hint: checkpointsReady
            ? "All required checkpoint cards are saved."
            : `Save ${enabledVerificationSections.map((section) => verificationSectionLabels[section]).join(", ")} before completing.`,
        },
        "ready-to-complete": {
          complete: checkpointsReady,
          disabled: !checkpointsReady || saveState === "saving",
          hint: checkpointsReady
            ? "You can now complete this task."
            : "Complete becomes available after all checkpoint cards are saved.",
        },
      };
    },
    [
      alignmentBusy,
      allSectionsVerified,
      audioMaskingEnabled,
      autoMaskingBusy,
      enabledVerificationSections,
      finalTranscript,
      maskIntervalsDirty,
      maskedAudioUrl,
      maskingBusy,
      piiAnnotations.length,
      piiDetectionBusy,
      piiDetectionReviewedTranscript,
      piiEnabled,
      saveState,
      status,
      verifiedSections.pii,
      verifiedSections.transcript,
    ]
  );

  useEffect(() => {
    if (!accessToken || !taskId) return;
    const token: string = accessToken;
    const resolvedTaskId: string = taskId;
    let cancelled = false;

    async function loadTask() {
      setLoading(true);
      try {
        const [fetchedTask, signedAudio, fetchedAudioGroup] = await Promise.all([
          fetchTask(token, resolvedTaskId),
          fetchAudioURL(token, resolvedTaskId),
          fetchTaskAudioGroup(token, resolvedTaskId).catch(() => null),
        ]);
        const labelsResponse = piiEnabled ? await fetchPIILabels(token).catch(() => ({ items: [] })) : { items: [] };
        if (cancelled) return;
        let activeTask = fetchedTask;
        let startError: string | null = null;
        if (fetchedTask.status === "Not Started" && (user?.role === "ANNOTATOR" || user?.role === "REVIEWER")) {
          try {
            const startedTaskResponse = await startTask(token, resolvedTaskId);
            activeTask = startedTaskResponse.task;
          } catch (err) {
            startError = err instanceof APIError ? err.message : "Failed to start task";
          }
          if (cancelled) return;
        }
        applyTaskState(activeTask);
        applyAudioGroupState(fetchedAudioGroup);
        setPiiLabelOptions(piiEnabled ? toPIILabelOptions(labelsResponse.items) : []);
        retryAttemptRef.current = 0;
        clearRetryTimer();

        if (draftStorageKey) {
          let parsedDraft: LocalTaskDraft | null = null;
          try {
            parsedDraft = parseLocalDraft(localStorage.getItem(draftStorageKey));
          } catch {
            parsedDraft = null;
          }
          if (parsedDraft && parsedDraft.task_id === fetchedTask.id) {
            const sameServerRevision =
              parsedDraft.base_version === fetchedTask.version ||
              parsedDraft.base_updated_at === fetchedTask.updated_at;

            if (sameServerRevision) {
              applyLocalDraftState(parsedDraft);
              setDraftState({ mode: "restored", savedAt: parsedDraft.saved_at });
            } else {
              setDraftState({ mode: "pending", savedAt: parsedDraft.saved_at });
            }
          } else {
            setDraftState({ mode: "none", savedAt: null });
          }
        } else {
          setDraftState({ mode: "none", savedAt: null });
        }

        setAudioUrl(`${backendBase}${signedAudio.url}`);
        setError(startError);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof APIError ? err.message : "Failed to load task");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadTask();
    return () => {
      cancelled = true;
    };
  }, [accessToken, taskId, backendBase, draftStorageKey, piiEnabled, user?.role]);

  useEffect(() => {
    if (!visibleInspectorTabs.some((tab) => tab.key === activeInspectorPanel)) {
      setActiveInspectorPanel("compare");
    }
  }, [activeInspectorPanel, visibleInspectorTabs]);

  useEffect(() => {
    if (fullReviewTouched) return;
    setFullReviewTranscript(assembledSegmentTranscript);
  }, [assembledSegmentTranscript, fullReviewTouched]);

  useEffect(() => {
    if (!hasUnsavedChanges || !taskId) return;
    const timeout = window.setTimeout(() => {
      void saveAll();
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [hasUnsavedChanges, finalTranscript, piiAnnotations, metadata, customMetadata, notes, status, taskId]);

  useEffect(() => {
    if (piiLabelOptions.some((label) => label.key === selectionLabel)) {
      return;
    }
    setSelectionLabel(piiLabelOptions[0]?.key ?? "OTHER");
  }, [piiLabelOptions, selectionLabel]);

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  useEffect(() => {
    setTranscriptDirty(finalTranscript !== originalTranscript);
  }, [finalTranscript, originalTranscript]);

  useEffect(() => {
    if (finalTranscript === originalTranscript) return;
    if (alignmentWords.length > 0) {
      setAlignmentWords([]);
      setAlignmentMessage("Transcript changed. Re-run alignment before word playback or masking.");
      setMaskedAudioUrl(null);
      setMaskedIntervals([]);
      setAcceptedMaskIntervals([]);
      setAlignmentMaskIntervals([]);
      setMaskedAudioMode(null);
      setMaskIntervalsDirty(false);
      setActiveWordIndex(null);
      markSectionsUnverified(["pii", "masking"]);
    }
  }, [alignmentWords.length, finalTranscript, originalTranscript]);

  useEffect(() => {
    setPiiAnnotations((prev) => {
      const sanitized = sanitizePIIAnnotations(finalTranscript, prev);
      if (JSON.stringify(sanitized) === JSON.stringify(prev)) {
        return prev;
      }
      return sanitized;
    });
  }, [finalTranscript]);

  useEffect(() => {
    setNotesDirty(notes !== originalNotes);
  }, [notes, originalNotes]);

  useEffect(() => {
    setStatusDirty(status !== originalStatus);
  }, [status, originalStatus]);

  useEffect(() => {
    if (!piiEnabled) {
      setPiiDirty(false);
      return;
    }
    const normalizedCurrent = sanitizePIIAnnotations(finalTranscript, piiAnnotations);
    const normalizedOriginal = sanitizePIIAnnotations(finalTranscript, originalPIIAnnotations);
    setPiiDirty(JSON.stringify(normalizedCurrent) !== JSON.stringify(normalizedOriginal));
  }, [finalTranscript, originalPIIAnnotations, piiAnnotations, piiEnabled]);

  useEffect(() => {
    piiAnnotationsRef.current = piiAnnotations;
  }, [piiAnnotations]);

  useEffect(() => {
    if (!metadataEnabled) {
      setMetadataDirty(false);
      return;
    }
    const coreChanged =
      metadata.speaker_gender !== originalMetadata.speaker_gender ||
      metadata.speaker_role !== originalMetadata.speaker_role ||
      metadata.language !== originalMetadata.language ||
      metadata.channel !== originalMetadata.channel ||
      metadata.duration_seconds !== originalMetadata.duration_seconds;

    const allCustomKeys = new Set([
      ...Object.keys(customMetadata),
      ...Object.keys(originalCustomMetadata)
    ]);
    let customChanged = false;
    allCustomKeys.forEach((key) => {
      if ((customMetadata[key] ?? "") !== (originalCustomMetadata[key] ?? "")) {
        customChanged = true;
      }
    });
    setMetadataDirty(coreChanged || customChanged);
  }, [customMetadata, metadata, metadataEnabled, originalCustomMetadata, originalMetadata]);

  useEffect(() => {
    if (!task || !draftStorageKey) return;
    if (!hasUnsavedChanges) {
      clearLocalDraft();
      return;
    }

    const draft: LocalTaskDraft = {
      schema_version: LOCAL_DRAFT_SCHEMA_VERSION,
      task_id: task.id,
      user_id: user?.id ?? null,
      base_version: version,
      base_updated_at: task.updated_at,
      saved_at: new Date().toISOString(),
      final_transcript: finalTranscript,
      notes,
      status,
      metadata,
      custom_metadata: customMetadata,
      pii_annotations: sanitizePIIAnnotations(finalTranscript, piiAnnotations),
    };

    try {
      localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch {
      // Ignore quota/storage access errors.
    }
  }, [
    task,
    draftStorageKey,
    hasUnsavedChanges,
    user?.id,
    version,
    finalTranscript,
    notes,
    status,
    metadata,
    customMetadata,
    piiAnnotations,
  ]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedChangesRef.current) return;
      void saveAllRef.current();
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden" && hasUnsavedChangesRef.current) {
        void saveAllRef.current();
      }
    }

    function handlePageHide() {
      if (hasUnsavedChangesRef.current) {
        void saveAllRef.current();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  useEffect(
    () => () => {
      clearRetryTimer();
      clearWordStopTimer();
    },
    []
  );

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const editableTarget = isEditableShortcutTarget(event.target);
      const transcriptTarget = event.target === transcriptTextareaRef.current;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveAllRef.current();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && allSectionsVerified) {
        event.preventDefault();
        void handleSaveAndNext();
        return;
      }

      if (piiEnabled && event.altKey && key === "m" && (!editableTarget || transcriptTarget)) {
        event.preventDefault();
        handleAddPIIFromSelection(selectionLabel);
        return;
      }

      if (editableTarget) {
        return;
      }

      if (event.altKey && event.key === "ArrowLeft" && task?.prev_task_id) {
        event.preventDefault();
        router.push(`/tasks/${task.prev_task_id}`);
        return;
      }

      if (event.altKey && event.key === "ArrowRight" && task?.next_task_id && allSectionsVerified) {
        event.preventDefault();
        void handleSaveAndNext();
        return;
      }

      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        key === "n" &&
        task?.next_task_id &&
        allSectionsVerified
      ) {
        event.preventDefault();
        void handleSaveAndNext();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  function applyTaskState(nextTask: TaskDetail, options: { preserveVerification?: boolean } = {}) {
    setTask(nextTask);
    setVersion(nextTask.version);
    versionRef.current = nextTask.version;
    const nextCoreMetadata: CoreMetadataState = {
      speaker_gender: nextTask.speaker_gender ?? "",
      speaker_role: nextTask.speaker_role ?? "",
      language: nextTask.language ?? "",
      channel: nextTask.channel ?? "",
      duration_seconds:
        nextTask.duration_seconds !== null && nextTask.duration_seconds !== undefined
          ? String(nextTask.duration_seconds)
          : ""
    };
    const nextCustomMetadata = Object.fromEntries(
      Object.entries(nextTask.custom_metadata ?? {}).map(([key, value]) => [key, String(value ?? "")])
    );
    const nextTranscript = nextTask.final_transcript ?? "";
    const persistedPII = sanitizePIIAnnotations(nextTranscript, nextTask.pii_annotations ?? []);
    const nextPIIAnnotations = piiEnabled
      ? persistedPII.length > 0
        ? persistedPII
        : detectPIIAnnotations(nextTranscript)
      : [];

    setFinalTranscript(nextTranscript);
    setNotes(nextTask.notes ?? "");
    setStatus(nextTask.status);
    setMetadata(nextCoreMetadata);
    setCustomMetadata(nextCustomMetadata);
    setPiiAnnotations(nextPIIAnnotations);
    setTranscriptSelection(null);
    setAlignmentWords(nextTask.alignment_words ?? []);
    setAlignmentMessage(nextTask.alignment_words?.length ? null : "Align the transcript to enable word playback.");
    setMaskedAudioUrl(null);
    setMaskedIntervals(nextTask.masked_audio_intervals ?? []);
    setAcceptedMaskIntervals(nextTask.masked_audio_reference_intervals ?? []);
    setAlignmentMaskIntervals(nextTask.masked_audio_alignment_intervals ?? []);
    setMaskedAudioMode(nextTask.masked_audio_mode ?? null);
    setMaskIntervalsDirty(false);
    setActiveWordIndex(null);

    setOriginalTranscript(nextTranscript);
    setOriginalNotes(nextTask.notes ?? "");
    setOriginalStatus(nextTask.status);
    setOriginalMetadata(nextCoreMetadata);
    setOriginalCustomMetadata(nextCustomMetadata);
    setOriginalPIIAnnotations(nextPIIAnnotations);

    setTranscriptDirty(false);
    setMetadataDirty(false);
    setNotesDirty(false);
    setStatusDirty(false);
    setPiiDirty(false);
    setSaveState("saved");
    setSectionErrors({});
    if (!options.preserveVerification) {
      setVerifiedSections(deriveSectionSaveState(nextTask.status, nextPIIAnnotations, nextTask.masked_audio_intervals ?? []));
    }
  }

  function applyAudioGroupState(nextGroup: TaskAudioGroup | null) {
    setAudioGroup(nextGroup);
    setFullAudioUrl(nextGroup?.full_audio_url ? `${backendBase}${nextGroup.full_audio_url}` : null);
    setFullReviewTouched(false);
    setFullReviewTranscript(nextGroup?.assembled_transcript ?? "");
    setFullReviewOpen(false);
  }

  async function handleFullReviewToggle() {
    if (fullReviewOpen) {
      setFullReviewOpen(false);
      return;
    }

    if (accessToken && task?.id) {
      try {
        const refreshedGroup = await fetchTaskAudioGroup(accessToken, task.id);
        setAudioGroup(refreshedGroup);
        setFullAudioUrl(refreshedGroup.full_audio_url ? `${backendBase}${refreshedGroup.full_audio_url}` : null);
        if (!fullReviewTouched) {
          setFullReviewTranscript(refreshedGroup.assembled_transcript ?? "");
        }
      } catch {
        // Keep the existing group details if the refresh fails; the player will show the current availability state.
      }
    }

    setFullReviewOpen(true);
  }

  function applyLocalDraftState(draft: LocalTaskDraft) {
    setFinalTranscript(draft.final_transcript);
    setNotes(draft.notes);
    setStatus(draft.status);
    setMetadata({
      speaker_gender: draft.metadata.speaker_gender ?? "",
      speaker_role: draft.metadata.speaker_role ?? "",
      language: draft.metadata.language ?? "",
      channel: draft.metadata.channel ?? "",
      duration_seconds: draft.metadata.duration_seconds ?? ""
    });
    setCustomMetadata(draft.custom_metadata);
    setPiiAnnotations(sanitizePIIAnnotations(draft.final_transcript, draft.pii_annotations));
    setTranscriptSelection(null);
    setSaveState("unsaved");
    setVerifiedSections({ ...emptyVerificationState });
  }

  function clearRetryTimer() {
    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }

  function clearWordStopTimer() {
    if (wordStopTimerRef.current) {
      window.clearTimeout(wordStopTimerRef.current);
      wordStopTimerRef.current = null;
    }
  }

  function clearLocalDraft() {
    if (!draftStorageKey) return;
    try {
      localStorage.removeItem(draftStorageKey);
    } catch {
      // Ignore quota/storage access errors.
    }
  }

  function markSectionsUnverified(keys: VerificationSectionKey[]) {
    setVerifiedSections((prev) => {
      const next = { ...prev };
      keys.forEach((key) => {
        next[key] = false;
      });
      return next;
    });
  }

  function automaticStatusPath(currentStatus: TaskStatus): TaskStatus[] {
    if (currentStatus === "Not Started") {
      return ["In Progress", "Completed"];
    }
    if (currentStatus === "In Progress") {
      return ["Completed"];
    }
    if (currentStatus === "Needs Review") {
      return ["Reviewed"];
    }
    if (currentStatus === "Reviewed") {
      return ["Approved"];
    }
    return [];
  }

  function scheduleRetrySave() {
    if (!accessToken || !taskId || retryTimeoutRef.current || !hasUnsavedChangesRef.current) return;
    const attempt = retryAttemptRef.current + 1;
    retryAttemptRef.current = attempt;
    const delay = Math.min(MAX_AUTOSAVE_RETRY_DELAY_MS, 2000 * 2 ** (attempt - 1));

    retryTimeoutRef.current = window.setTimeout(() => {
      retryTimeoutRef.current = null;
      if (!hasUnsavedChangesRef.current) return;
      void saveAllRef.current();
    }, delay);

    setError(`Save failed. Retrying in ${Math.round(delay / 1000)}s.`);
  }

  function collectTextValidationErrors(): Array<{ section: SaveSectionKey | "status"; message: string }> {
    const checks: Array<{ section: SaveSectionKey | "status"; label: string; value: string | null | undefined }> = [];
    if (transcriptDirty) {
      checks.push({ section: "transcript", label: "transcript", value: finalTranscript });
    }
    if (notesDirty) {
      checks.push({ section: "notes", label: "notes", value: notes });
    }

    return checks.flatMap((check) => {
      const message = validateAnnotationText(check.value, check.label);
      return message ? [{ section: check.section, message }] : [];
    });
  }

  function stopForTextValidation(errors: Array<{ section: SaveSectionKey | "status"; message: string }>) {
    const message = errors[0]?.message ?? "Invalid characters found.";
    setSaveState("error");
    setError(message);
    setSectionErrors(
      errors.reduce<Record<string, string>>((next, item) => {
        if (!next[item.section]) {
          next[item.section] = item.message;
        }
        return next;
      }, {})
    );
    clearRetryTimer();
    retryAttemptRef.current = 0;
    return false;
  }

  async function saveAll(versionOverride?: number): Promise<boolean> {
    if (!accessToken || !taskId || savingRef.current) return false;
    const token: string = accessToken;
    const resolvedTaskId: string = taskId;
    const validationErrors = collectTextValidationErrors();
    if (validationErrors.length > 0) {
      return stopForTextValidation(validationErrors);
    }
    if (!hasUnsavedChanges && !versionOverride) return true;

    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    setSectionErrors({});

    const sanitizedPIIAnnotations = sanitizePIIAnnotations(finalTranscript, piiAnnotations);
    let currentVersion = versionOverride ?? version;
    const dirtySections: string[] = [];
    try {
      const payload: Parameters<typeof patchTaskCombined>[2] = { version: currentVersion };
      if (transcriptDirty) {
        payload.final_transcript = finalTranscript;
        dirtySections.push("transcript");
      }

      if (metadataEnabled && metadataDirty) {
        const parsedDuration = metadata.duration_seconds.trim() ? Number(metadata.duration_seconds) : null;
        payload.speaker_gender = metadata.speaker_gender || null;
        payload.speaker_role = metadata.speaker_role || null;
        payload.language = metadata.language || null;
        payload.channel = metadata.channel || null;
        payload.duration_seconds = Number.isNaN(parsedDuration) ? null : parsedDuration;
        payload.custom_metadata = customMetadata;
        dirtySections.push("metadata");
      }

      if (notesDirty) {
        payload.notes = notes || null;
        dirtySections.push("notes");
      }

      if (statusDirty) {
        payload.status = status;
        dirtySections.push("status");
      }

      if (piiEnabled && piiDirty) {
        payload.pii_annotations = sanitizedPIIAnnotations;
        dirtySections.push("pii");
      }

      if (dirtySections.length === 0) {
        setSaveState("saved");
        clearRetryTimer();
        retryAttemptRef.current = 0;
        clearLocalDraft();
        setDraftState({ mode: "none", savedAt: null });
        return true;
      }

      const response = await patchTaskCombined(token, resolvedTaskId, payload);
      currentVersion = response.task.version;
      setVersion(currentVersion);
      applyTaskState(response.task, { preserveVerification: true });
      setSaveState("saved");
      clearRetryTimer();
      retryAttemptRef.current = 0;
      clearLocalDraft();
      setDraftState({ mode: "none", savedAt: null });
      return true;
    } catch (err) {
      if (err instanceof APIError && err.status === 409) {
        const detail = (err.payload as { detail?: { server_task?: TaskDetail; conflicting_fields?: string[] } })
          ?.detail;
        setConflict({
          open: true,
          serverTask: detail?.server_task ?? null,
          conflictingFields: detail?.conflicting_fields ?? []
        });
        setSaveState("error");
        clearRetryTimer();
        retryAttemptRef.current = 0;
      } else {
        setSaveState("error");
        const message = err instanceof APIError ? err.message : "Save failed";
        setError(message);
        setSectionErrors(
          Object.fromEntries(
            (dirtySections.length
              ? dirtySections
              : [
                  "transcript",
                  ...(metadataEnabled ? ["metadata"] : []),
                  "notes",
                  "status",
                  ...(piiEnabled ? ["pii"] : []),
                ]).map(
              (section) => [section, message]
            )
          )
        );
        const shouldRetry = !(err instanceof APIError) || err.status >= 500;
        if (shouldRetry) {
          scheduleRetrySave();
        } else {
          clearRetryTimer();
          retryAttemptRef.current = 0;
        }
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }
  saveAllRef.current = saveAll;

  function handleUseServer() {
    if (!conflict.serverTask) return;
    applyTaskState(conflict.serverTask);
    setConflict({ open: false, serverTask: null, conflictingFields: [] });
  }

  function handleUseMine() {
    if (!conflict.serverTask) return;
    const serverVersion = conflict.serverTask.version;
    setVersion(serverVersion);
    setConflict({ open: false, serverTask: null, conflictingFields: [] });
    void saveAll(serverVersion);
  }

  function handleMerge(resolution?: ConflictMergeResolution) {
    if (!conflict.serverTask) return;
    const mergedTask = conflict.serverTask;
    const serverMetadata: CoreMetadataState = {
      speaker_gender: mergedTask.speaker_gender ?? "",
      speaker_role: mergedTask.speaker_role ?? "",
      language: mergedTask.language ?? "",
      channel: mergedTask.channel ?? "",
      duration_seconds:
        mergedTask.duration_seconds !== null && mergedTask.duration_seconds !== undefined
          ? String(mergedTask.duration_seconds)
          : "",
    };
    const serverCustomMetadata = Object.fromEntries(
      Object.entries(mergedTask.custom_metadata ?? {}).map(([key, value]) => [key, String(value ?? "")])
    );

    Object.entries(resolution ?? {}).forEach(([field, choice]) => {
      if (choice !== "server") return;
      if (field === "final_transcript") {
        const serverTranscript = mergedTask.final_transcript ?? "";
        setFinalTranscript(serverTranscript);
        setOriginalTranscript(serverTranscript);
        setTranscriptDirty(false);
      }
      if (field === "notes") {
        const serverNotes = mergedTask.notes ?? "";
        setNotes(serverNotes);
        setOriginalNotes(serverNotes);
        setNotesDirty(false);
      }
      if (field === "status") {
        setStatus(mergedTask.status);
        setOriginalStatus(mergedTask.status);
        setStatusDirty(false);
      }
      if (field === "pii_annotations") {
        const serverPII = sanitizePIIAnnotations(mergedTask.final_transcript ?? finalTranscript, mergedTask.pii_annotations ?? []);
        setPiiAnnotations(serverPII);
        setOriginalPIIAnnotations(serverPII);
        setPiiDirty(false);
      }
      if (field in serverMetadata) {
        setMetadata((prev) => ({ ...prev, [field]: serverMetadata[field as keyof CoreMetadataState] }));
        setOriginalMetadata((prev) => ({ ...prev, [field]: serverMetadata[field as keyof CoreMetadataState] }));
        setMetadataDirty(false);
      }
      if (field === "custom_metadata") {
        setCustomMetadata(serverCustomMetadata);
        setOriginalCustomMetadata(serverCustomMetadata);
        setMetadataDirty(false);
      }
    });

    setVersion(mergedTask.version);
    setConflict({ open: false, serverTask: null, conflictingFields: [] });
    window.setTimeout(() => void saveAll(mergedTask.version), 0);
  }

  function mergeDetectedPIIAnnotations(
    transcript: string,
    current: PIIAnnotation[],
    detected: PIIAnnotation[]
  ) {
    const merged = [...current];
    detected.forEach((annotation) => {
      const duplicate = merged.some(
        (item) =>
          item.start === annotation.start &&
          item.end === annotation.end &&
          item.label === annotation.label
      );
      if (!duplicate) {
        merged.push(annotation);
      }
    });
    return sanitizePIIAnnotations(transcript, merged);
  }

  async function runPIIDetection(options: { includeMl?: boolean; mergeExisting?: boolean; auto?: boolean } = {}) {
    if (!piiEnabled) {
      setPiiDetectionMessage("PII review is disabled for this organization.");
      return;
    }
    const transcript = finalTranscript;
    if (!transcript.trim()) {
      setPiiDetectionMessage("Add transcript text before running PII detection.");
      return;
    }
    if (piiDetectionBusy) {
      return;
    }
    if (options.auto && piiAutoDetectionTranscriptRef.current === transcript) {
      return;
    }

    setPiiDetectionBusy(true);
    setPiiDetectionMessage("Scanning transcript with all PII models...");
    const preliminary = sanitizePIIAnnotations(transcript, detectPIIAnnotations(transcript));
    const immediateNext = options.mergeExisting
      ? mergeDetectedPIIAnnotations(transcript, piiAnnotations, preliminary)
      : preliminary;
    if (JSON.stringify(immediateNext) !== JSON.stringify(piiAnnotations)) {
      piiAnnotationsRef.current = immediateNext;
      setPiiAnnotations(immediateNext);
      setMaskedAudioUrl(null);
      setMaskedIntervals([]);
      setAcceptedMaskIntervals([]);
      setAlignmentMaskIntervals([]);
      setMaskedAudioMode(null);
      setMaskIntervalsDirty(false);
      markSectionsUnverified(["pii", "masking"]);
      setSaveState("unsaved");
    }

    try {
      let detected = preliminary;
      if (accessToken) {
        try {
          const response = await detectTaskPII(accessToken, transcript, options.includeMl ?? false);
          detected = response.pii_annotations;
        } catch {
          detected = detectPIIAnnotations(transcript);
        }
      }

      const currentAnnotations = piiAnnotationsRef.current;
      const next = options.mergeExisting
        ? mergeDetectedPIIAnnotations(transcript, currentAnnotations, detected)
        : sanitizePIIAnnotations(transcript, detected);

      if (JSON.stringify(next) !== JSON.stringify(currentAnnotations)) {
        piiAnnotationsRef.current = next;
        setPiiAnnotations(next);
        setMaskedAudioUrl(null);
        setMaskedIntervals([]);
        setAcceptedMaskIntervals([]);
        setAlignmentMaskIntervals([]);
        setMaskedAudioMode(null);
        setMaskIntervalsDirty(false);
        markSectionsUnverified(["pii", "masking"]);
        setSaveState("unsaved");
      }

      setTranscriptSelection(null);
      setError(null);
      piiAutoDetectionTranscriptRef.current = transcript;
      setPiiDetectionReviewedTranscript(transcript);
      setPiiDetectionMessage(
        `PII scan complete. Review ${piiAnnotationsRef.current.length} detected entit${
          piiAnnotationsRef.current.length === 1 ? "y" : "ies"
        }.`
      );
    } finally {
      setPiiDetectionBusy(false);
    }
  }

  async function handleDetectPII() {
    await runPIIDetection({ includeMl: true });
  }

  function handleInspectorTabClick(tabKey: InspectorPanelKey) {
    if (!visibleInspectorTabs.some((tab) => tab.key === tabKey)) return;
    setActiveInspectorPanel(tabKey);
    if (tabKey === "pii") {
      void runPIIDetection({ includeMl: true, mergeExisting: true, auto: true });
    }
  }

  function handleTourStepChange(step: AnnotatorGuidedTourStep) {
    const targetPanel = step.inspectorPanel;
    if (!targetPanel || !visibleInspectorTabs.some((tab) => tab.key === targetPanel)) {
      return;
    }
    handleInspectorTabClick(targetPanel as InspectorPanelKey);
  }

  async function handleGuidedTourAction(step: AnnotatorGuidedTourStep) {
    switch (step.actionId) {
      case "focus-transcript":
        transcriptTextareaRef.current?.focus();
        transcriptTextareaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      case "run-pii-detection":
        if (!piiEnabled) return true;
        setActiveInspectorPanel("pii");
        await handleDetectPII();
        return true;
      case "create-masked-audio":
        if (!audioMaskingEnabled) return true;
        if (piiAnnotations.length === 0) {
          return true;
        }
        return handleMaskPIIAudio(false);
      case "save-pending-checkpoints":
        return handleSavePendingGuidedSections();
      case "complete-task":
        if (workflowSavedStatuses.includes(status)) {
          return true;
        }
        return handleSaveAndNext();
      default:
        return true;
    }
  }

  async function handleSavePendingGuidedSections() {
    for (const section of enabledVerificationSections) {
      if (!verifiedSections[section]) {
        await handleSaveSection(section);
      }
    }
    return true;
  }

  function syncTranscriptSelection() {
    const textarea = transcriptTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selectedValue = finalTranscript.slice(start, end);

    if (end <= start || !selectedValue.trim()) {
      setTranscriptSelection(null);
      return;
    }

    setTranscriptSelection({ start, end, value: selectedValue });
  }

  function handleAddPIIFromSelection(label: string = selectionLabel) {
    if (!piiEnabled) return;
    const activeSelection =
      transcriptSelection ??
      (() => {
        const textarea = transcriptTextareaRef.current;
        if (!textarea) return null;
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        const selectedValue = finalTranscript.slice(start, end);
        if (end <= start || !selectedValue.trim()) return null;
        return { start, end, value: selectedValue };
      })();

    if (!activeSelection) {
      setError("Select text in the final transcript to add a PII entity.");
      return;
    }

    const { start, end, value } = activeSelection;
    const existingAnnotation = piiAnnotations.find((item) => item.start === start && item.end === end);

    const next = sanitizePIIAnnotations(
      finalTranscript,
      existingAnnotation
        ? piiAnnotations.map((item) =>
            item.id === existingAnnotation.id
              ? { ...item, label, value, start, end, source: "manual", confidence: null }
              : item
          )
        : [
            ...piiAnnotations,
            {
              id:
                typeof crypto !== "undefined" && "randomUUID" in crypto
                  ? crypto.randomUUID()
                  : `pii-${Date.now()}`,
              label,
              start,
              end,
              value,
              source: "manual",
              confidence: null,
            },
          ]
    );
    setPiiAnnotations(next);
    setTranscriptSelection(null);
    setActiveInspectorPanel("pii");
    setMaskedAudioUrl(null);
    setMaskedIntervals([]);
    setAcceptedMaskIntervals([]);
    setAlignmentMaskIntervals([]);
    setMaskedAudioMode(null);
    setMaskIntervalsDirty(false);
    markSectionsUnverified(["pii", "masking"]);
    setSaveState("unsaved");
    setError(null);
  }

  function handleChangePII(annotations: PIIAnnotation[]) {
    if (!piiEnabled) return;
    const sanitized = sanitizePIIAnnotations(finalTranscript, annotations);
    setPiiAnnotations(sanitized);
    setMaskedAudioUrl(null);
    setMaskedIntervals([]);
    setAcceptedMaskIntervals([]);
    setAlignmentMaskIntervals([]);
    setMaskedAudioMode(null);
    setMaskIntervalsDirty(false);
    markSectionsUnverified(["pii", "masking"]);
    setSaveState("unsaved");
  }

  async function handleGenerateAlignment(force = false, options: { skipSave?: boolean } = {}) {
    if (!accessToken || !taskId) return false;
    if (!options.skipSave) {
      const saved = await saveAll();
      if (!saved) {
        setAlignmentMessage("Save the current transcript and PII edits before alignment.");
        return false;
      }
    }
    setAlignmentBusy(true);
    setAlignmentMessage(null);
    setError(null);
    try {
      const response = await generateTaskAlignment(accessToken, taskId, force);
      setAlignmentWords(response.words);
      setAlignmentMessage(`Aligned ${response.words.length} transcript words.`);
      return true;
    } catch (err) {
      const message = err instanceof APIError ? err.message : "Forced alignment failed";
      setAlignmentMessage(message);
      setError(message);
      return false;
    } finally {
      setAlignmentBusy(false);
    }
  }

  function handleAudioMaskModeChange(mode: AudioMaskMode) {
    if (!audioMaskingEnabled) return;
    setAudioMaskMode(mode);
    if (maskedAudioUrl && maskedAudioMode !== mode) {
      setMaskedAudioUrl(null);
      setMaskedIntervals([]);
      setMaskedAudioMode(null);
      setMaskIntervalsDirty(false);
      markSectionsUnverified(["masking"]);
      setAlignmentMessage("Masking mode changed. Generate a new masked preview.");
    }
  }

  function handleMaskIntervalsChange(nextIntervals: AudioMaskInterval[]) {
    if (!audioMaskingEnabled) return;
    setMaskedIntervals(nextIntervals);
    setMaskIntervalsDirty(true);
    setMaskedAudioUrl(null);
    setMaskedAudioMode(null);
    markSectionsUnverified(["masking"]);
    setAlignmentMessage("PII mask window adjusted. Regenerate masked audio to verify it.");
  }

  function handleMaskIntervalFieldChange(index: number, edge: "start_seconds" | "end_seconds", value: string) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    handleMaskIntervalsChange(
      maskedIntervals.map((interval, itemIndex) => {
        if (itemIndex !== index) return interval;
        const nextValue = roundTimestampSeconds(Math.max(0, parsed));
        if (edge === "start_seconds") {
          return {
            ...interval,
            start_seconds: roundTimestampSeconds(Math.min(nextValue, Math.max(0, interval.end_seconds - 0.05))),
          };
        }
        return { ...interval, end_seconds: roundTimestampSeconds(Math.max(nextValue, interval.start_seconds + 0.05)) };
      })
    );
  }

  function handleAudioMaskModeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, mode: AudioMaskMode) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = audioMaskModeOptions.findIndex((option) => option.value === mode);
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + direction + audioMaskModeOptions.length) % audioMaskModeOptions.length;
    handleAudioMaskModeChange(audioMaskModeOptions[nextIndex].value);
  }

  async function handleMaskPIIAudio(force = false, options: { skipSave?: boolean } = {}) {
    if (!accessToken || !taskId) return false;
    if (!audioMaskingEnabled) {
      setError("Audio masking is disabled for this organization.");
      return false;
    }
    const customMaskIntervals = maskedIntervals.length > 0 ? maskedIntervals : null;
    if (piiAnnotations.length === 0 && !customMaskIntervals) {
      setError("Add at least one PII annotation before masking audio.");
      return false;
    }
    if (!options.skipSave) {
      const saved = await saveAll();
      if (!saved) {
        setError("Save the current PII annotations before masking audio.");
        return false;
      }
    }
    setMaskingBusy(true);
    setAlignmentMessage(null);
    setError(null);
    try {
      const response = customMaskIntervals
        ? await maskTaskPIIAudio(accessToken, taskId, force, audioMaskMode, customMaskIntervals)
        : await maskTaskPIIAudio(accessToken, taskId, force, audioMaskMode);
      setAlignmentWords(response.words);
      setMaskedIntervals(response.masked_intervals);
      setAcceptedMaskIntervals(response.accepted_intervals ?? response.masked_intervals);
      setAlignmentMaskIntervals(response.alignment_intervals ?? []);
      setMaskedAudioUrl(`${backendBase}${response.masked_audio_url}`);
      const returnedMaskMode = response.mask_mode ?? audioMaskMode;
      setMaskedAudioMode(returnedMaskMode);
      setMaskIntervalsDirty(false);
      markSectionsUnverified(["masking"]);
      setAlignmentMessage(
        `Masked ${response.masked_intervals.length} audio span${response.masked_intervals.length === 1 ? "" : "s"} with ${returnedMaskMode}.`
      );
      return true;
    } catch (err) {
      const message = err instanceof APIError ? err.message : "PII audio masking failed";
      setAlignmentMessage(message);
      setError(message);
      return false;
    } finally {
      setMaskingBusy(false);
    }
  }

  function handleWordAudioTimeUpdate() {
    const audio = wordAudioRef.current;
    if (!audio || wordStopAtRef.current === null) return;
    if (audio.currentTime >= wordStopAtRef.current) {
      audio.pause();
      clearWordStopTimer();
      wordStopAtRef.current = null;
      setActiveWordIndex(null);
    }
  }

  function playAlignedWord(word: AudioAlignmentWord) {
    const audio = wordAudioRef.current;
    if (!audio || !audioUrl) return;
    const startSeconds = Math.max(0, word.start_seconds);
    const endSeconds = Math.max(startSeconds + 0.05, word.end_seconds);
    const durationMs = Math.max(80, (endSeconds - startSeconds) * 1000);

    clearWordStopTimer();
    setActiveWordIndex(word.index);
    audio.pause();

    const cleanupPlayback = () => {
      clearWordStopTimer();
      wordStopAtRef.current = null;
      setActiveWordIndex(null);
    };

    const startPlayback = () => {
      try {
        audio.currentTime = startSeconds;
      } catch {
        cleanupPlayback();
        return;
      }
      wordStopAtRef.current = endSeconds;
      wordStopTimerRef.current = window.setTimeout(() => {
        audio.pause();
        cleanupPlayback();
      }, durationMs + 80);
      void audio.play().catch(cleanupPlayback);
    };

    const sourceChanged = audio.src !== audioUrl;
    if (sourceChanged) {
      audio.src = audioUrl;
    }
    if (!sourceChanged && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startPlayback();
      return;
    }
    audio.addEventListener("loadedmetadata", startPlayback, { once: true });
    audio.load();
  }

  async function handleSaveSection(section: VerificationSectionKey) {
    if (!enabledVerificationSections.includes(section)) {
      setVerifiedSections((prev) => ({ ...prev, [section]: true }));
      return;
    }
    if (section === "masking" && maskingApprovalBlocked) {
      setError("Generate and check masked audio before saving audio masking.");
      return;
    }

    const saved = await saveAll();
    if (!saved) return;
    setVerifiedSections((prev) => ({ ...prev, [section]: true }));
    setError(null);

    if (section === "pii" && audioMaskingEnabled && piiAnnotations.length > 0) {
      setAutoMaskingBusy(true);
      setAlignmentMessage("Aligning and masking...");
      setVerifiedSections((prev) => ({ ...prev, masking: false }));
      try {
        const aligned = await handleGenerateAlignment(false, { skipSave: true });
        if (!aligned) return;
        await handleMaskPIIAudio(false, { skipSave: true });
      } finally {
        setAutoMaskingBusy(false);
      }
    }
  }

  async function handleSaveAndNext() {
    if (!accessToken || !taskId || !allSectionsVerified) return false;

    const saved = await saveAll();
    if (!saved) return false;

    let nextTask = task;
    const targetStatuses = automaticStatusPath(status);
    if (targetStatuses.length > 0) {
      setSaveState("saving");
      setError(null);
      try {
        for (const targetStatus of targetStatuses) {
          const response = await patchTaskCombined(accessToken, taskId, {
            version: versionRef.current,
            status: targetStatus,
            comment: "All required sections verified",
          });
          nextTask = response.task;
          applyTaskState(response.task, { preserveVerification: true });
        }
        setSaveState("saved");
      } catch (err) {
        const message = err instanceof APIError ? err.message : "Failed to complete task";
        setSaveState("error");
        setError(message);
        setSectionErrors({ status: message });
        return false;
      }
    }

    const nextTaskId = nextTask?.next_task_id ?? task?.next_task_id;
    router.push(nextTaskId ? `/tasks/${nextTaskId}` : "/tasks");
    return true;
  }

  async function handleReviewDecision(targetStatus: Extract<TaskStatus, "Approved" | "Rejected">) {
    if (!accessToken || !taskId || reviewBusy) return;
    const comment = reviewComment.trim();
    if (targetStatus === "Rejected" && !comment) {
      setError("Add a rejection reason before rejecting the task.");
      return;
    }
    const commentValidationMessage = validateAnnotationText(comment, "review comment");
    if (commentValidationMessage) {
      stopForTextValidation([{ section: "status", message: commentValidationMessage }]);
      return;
    }

    const saved = await saveAll();
    if (!saved) return;

    setReviewBusy(true);
    setError(null);
    try {
      const response = await patchTaskCombined(accessToken, taskId, {
        version: versionRef.current,
        status: targetStatus,
        comment: targetStatus === "Approved" ? comment || "Reviewer approved task" : comment,
      });
      applyTaskState(response.task);
      setReviewComment("");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Review decision failed");
    } finally {
      setReviewBusy(false);
    }
  }

  function handleRestoreLocalDraft() {
    if (!draftStorageKey) return;
    let draft: LocalTaskDraft | null = null;
    try {
      draft = parseLocalDraft(localStorage.getItem(draftStorageKey));
    } catch {
      draft = null;
    }
    if (!draft || draft.task_id !== task?.id) {
      setDraftState({ mode: "none", savedAt: null });
      return;
    }
    applyLocalDraftState(draft);
    setDraftState({ mode: "restored", savedAt: draft.saved_at });
  }

  function handleDiscardLocalDraft() {
    clearLocalDraft();
    setDraftState({ mode: "none", savedAt: null });
  }

  if (loading) {
    return (
      <section className="oa-card max-w-xl px-4 py-3 text-sm text-[#676280]">Loading task workspace...</section>
    );
  }

  if (!task) {
    return (
      <section className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">
        {error ?? "Task not found"}
      </section>
    );
  }

  return (
    <section className="animate-fade-in space-y-4">
      <div
        aria-label="Confidential task watermark"
        className="pointer-events-none rounded-xl border border-[#e6dcf2] bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#514a70]"
      >
        Confidential task | {user?.email ?? "signed-in user"} | {task.external_id}
      </div>
      <div
        data-tour-id="task-overview"
        className="relative overflow-hidden rounded-[1.35rem] border border-[#e4e7ee] bg-[linear-gradient(135deg,#ffffff_0%,#f6f8fb_100%)] shadow-[0_22px_48px_-40px_rgba(15,23,42,0.45)]"
      >
        <div className="pointer-events-none absolute -left-28 top-8 h-56 w-56 rounded-full bg-[#eef2ff] blur-3xl" />
        <div className="pointer-events-none absolute -right-16 -top-12 h-44 w-44 rounded-full bg-[#fce7f3] blur-3xl" />
        <div className="relative z-10 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6b7280]">Annotation Workspace</p>
              <div className="mt-1 flex items-center gap-2">
                <h2 className="oa-title text-xl font-semibold">Task {task.external_id}</h2>
                <StatusBadge status={status} />
              </div>
              <p className="mt-1 max-w-[840px] break-all text-xs text-[#6b7280]">{task.file_location}</p>
            </div>

            <div data-tour-id="top-actions" className="flex flex-wrap items-center justify-end gap-2">
              {user?.role === "ANNOTATOR" ? (
                <AnnotatorGuidedTour
                  steps={visibleTourSteps}
                  milestones={guidedTourMilestones}
                  actionStatus={guidedTourActionStatus}
                  forceStartKey={requestedTour ? `${taskId}:tour` : null}
                  onForceStartConsumed={() => router.replace(`/tasks/${taskId}`)}
                  onStepChange={handleTourStepChange}
                  onStepAction={handleGuidedTourAction}
                />
              ) : null}
              <button
                type="button"
                disabled={!task.prev_task_id}
                onClick={() => task.prev_task_id && router.push(`/tasks/${task.prev_task_id}`)}
                className="oa-btn-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button type="button" onClick={() => void saveAll()} className="oa-btn-secondary px-4 py-1.5 text-sm font-medium">
                Save Now
              </button>
              {allSectionsVerified ? (
                <button
                  type="button"
                  onClick={() => void handleSaveAndNext()}
                  className="oa-btn-primary px-4 py-1.5 text-sm font-medium"
                >
                  {task.next_task_id ? "Save and Next" : "Save and Finish"}
                </button>
              ) : null}
            </div>
          </div>

          <div data-tour-id="task-context" className="mt-4 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {task.transcript_variants.length} ASR source{task.transcript_variants.length === 1 ? "" : "s"}
            </span>
            {piiEnabled ? (
              <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
                {piiAnnotations.length} PII label{piiAnnotations.length === 1 ? "" : "s"}
              </span>
            ) : null}
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {task.assignee_name ? `Assignee: ${task.assignee_name}` : "Unassigned"}
            </span>
            <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
              {task.last_tagger_name ? `Last Tagger: ${task.last_tagger_name}` : "Last Tagger: —"}
            </span>
            {metadataEnabled ? (
              <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-xs font-medium text-[#374151]">
                Duration {formatDurationLabel(metadata.duration_seconds)}
              </span>
            ) : null}
          </div>

          <div
            data-tour-id="save-state"
            className="mt-4 grid gap-3 border-t border-[#e5e7eb] pt-3 lg:grid-cols-[auto,1fr,auto] lg:items-center"
          >
            <SaveIndicator state={saveState} lastSavedAt={task.last_saved_at} />
            <span aria-live="polite" className="text-xs text-[#6b7280]">
              {hasUnsavedChanges ? "Pending save" : "All edits saved"}
            </span>
            <span className="justify-self-start rounded-full border border-[#dbeafe] bg-[#eff6ff] px-3 py-1 text-xs font-medium text-[#1d4ed8] lg:justify-self-end">
              Status updates automatically
            </span>
          </div>

          {visibleSaveSectionStatuses.length > 0 ? (
            <div
              aria-label="Autosave section status"
              aria-live="polite"
              className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4"
            >
              {visibleSaveSectionStatuses.map((section) => {
                const stateLabel = section.state === "failed" ? "Failed" : "Pending";
                const stateClass =
                  section.state === "failed"
                    ? "border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]"
                    : "border-[#ffd9a8] bg-[#fff8ec] text-[#925b17]";

                return (
                  <div key={section.key} className={`rounded-lg border px-2.5 py-2 text-xs ${stateClass}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{section.label}</span>
                      <span>{stateLabel}</span>
                    </div>
                    {section.failedMessage ? (
                      <p className="mt-1 line-clamp-2 text-[11px] opacity-90">{section.failedMessage}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div
            data-tour-id="completion-checkpoints"
            aria-label="Section save status"
            className="mt-3 grid gap-2 md:grid-cols-4"
          >
            {enabledVerificationSections.map(
              (key) => {
                const label = verificationSectionLabels[key];
                const verified = verifiedSections[key];
                const runningAutomation = key === "pii" && autoMaskingBusy;
                const disabled = autoMaskingBusy || (key === "masking" && maskingApprovalBlocked);
                const titleLabel = key === "transcript" ? "Compare Transcripts" : label;
                const buttonLabel = runningAutomation
                  ? "Aligning and masking..."
                  : verified
                    ? `${label} Saved`
                    : `Save ${label}`;
                return (
                  <div
                    key={key}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      verified
                        ? "border-[#bfe5cb] bg-[#f1fbf5] text-[#266544]"
                        : "border-[#e5e7eb] bg-white text-[#4b5563]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{titleLabel}</span>
                      <span>{runningAutomation ? "Saving" : verified ? "Saved" : "Pending"}</span>
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void handleSaveSection(key)}
                      className={`mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border px-2 py-1.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c6cb0] ${
                        verified
                          ? "border-[#bfe5cb] bg-white text-[#266544]"
                          : "border-[#d9d2ef] bg-[#fbf8ff] text-[#241f43] hover:bg-white"
                      } ${disabled ? "cursor-not-allowed opacity-55" : ""}`}
                    >
                      {runningAutomation ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                          />
                          <span>{buttonLabel}</span>
                        </>
                      ) : (
                        buttonLabel
                      )}
                    </button>
                  </div>
                );
              }
            )}
          </div>
        </div>
      </div>

      {draftState.mode !== "none" ? (
        <div
          data-tour-id="draft-recovery"
          className={`rounded-xl border px-4 py-3 text-sm ${
            draftState.mode === "pending"
              ? "border-[#ffd9a8] bg-[#fff5e7] text-[#925b17]"
              : "border-[#d8c2ef] bg-[#f5eeff] text-[#533b7f]"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              {draftState.mode === "pending"
                ? `Unsaved local draft found from ${draftState.savedAt ? new Date(draftState.savedAt).toLocaleString() : "a previous session"}.`
                : `Recovered unsaved draft from ${draftState.savedAt ? new Date(draftState.savedAt).toLocaleString() : "this device"}.`}
            </p>
            <div className="flex items-center gap-2">
              {draftState.mode === "pending" ? (
                <button type="button" onClick={handleRestoreLocalDraft} className="oa-btn-secondary px-3 py-1.5 text-xs font-medium">
                  Restore Draft
                </button>
              ) : null}
              <button type="button" onClick={handleDiscardLocalDraft} className="oa-btn-secondary px-3 py-1.5 text-xs font-medium">
                Discard Local Draft
              </button>
              {draftState.mode === "restored" ? (
                <button type="button" onClick={() => void saveAll()} className="oa-btn-primary px-3 py-1.5 text-xs font-medium">
                  Save Now
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.72fr)]">
        <div data-tour-id="keyboard-shortcuts" className="oa-card p-4">
          <h3 className="oa-title text-sm font-semibold">Keyboard Shortcuts</h3>
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-[#4b5563] sm:grid-cols-2 lg:grid-cols-4">
            <ShortcutHint keys="Space" label="Play / pause audio" />
            <ShortcutHint keys="J / L" label="Rewind or forward 5s" />
            <ShortcutHint keys="Ctrl + S" label="Save current edits" />
            <ShortcutHint keys="Ctrl + Enter" label="Save and next" />
            {piiEnabled ? <ShortcutHint keys="Alt + M" label="Tag selected PII" /> : null}
            <ShortcutHint keys="Alt + ← / →" label="Move between tasks" />
          </div>
        </div>

        {user?.role === "REVIEWER" && (status === "Needs Review" || status === "Reviewed") ? (
          <div className="oa-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="oa-title text-sm font-semibold">Review Decision</h3>
                <p className="mt-1 text-xs text-[#6b7280]">Check the required evidence, then approve or send back with a reason.</p>
              </div>
              <StatusBadge status={status} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-[#4b5563]">
              <ReviewCheck label="Corrected transcript" ready={Boolean(finalTranscript.trim())} />
              {piiEnabled ? <ReviewCheck label="PII tags" ready={piiAnnotations.length > 0} /> : null}
              {audioMaskingEnabled ? (
                <ReviewCheck label="Masked audio" ready={piiAnnotations.length === 0 || Boolean(maskedAudioUrl || maskedIntervals.length)} />
              ) : null}
            </div>
            <label className="mt-3 block text-xs font-medium text-[#4b5563]">
              Review rejection reason
              <textarea
                aria-label="Review rejection reason"
                value={reviewComment}
                onChange={(event) => setReviewComment(event.target.value)}
                rows={3}
                className="oa-textarea mt-1"
                placeholder="Required when rejecting"
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleReviewDecision("Approved")}
                disabled={reviewBusy}
                className="oa-btn-primary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {reviewBusy ? "Saving..." : "Approve Task"}
              </button>
              <button
                type="button"
                onClick={() => void handleReviewDecision("Rejected")}
                disabled={reviewBusy}
                className="rounded-lg border border-[#f0c8c8] bg-white px-3.5 py-2 text-sm font-semibold text-[#a13a3a] transition hover:bg-[#fff4f4] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Reject Task
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]">
        <div className="space-y-4">
          <div data-tour-id="audio-workspace" className="oa-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="oa-title text-sm font-semibold uppercase tracking-[0.1em] text-[#4b5563]">Audio</h3>
              {audioMaskingEnabled ? (
                <div data-tour-id="audio-mask-controls" className="flex flex-wrap items-center gap-2">
                  <div
                    role="radiogroup"
                    aria-label="PII Mask Audio Mode"
                    className="inline-flex rounded-xl border border-[#d9d2ef] bg-[#fbf8ff] p-0.5"
                  >
                    {audioMaskModeOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={audioMaskMode === option.value}
                        disabled={alignmentBusy || maskingBusy || autoMaskingBusy}
                        onClick={() => handleAudioMaskModeChange(option.value)}
                        onKeyDown={(event) => handleAudioMaskModeKeyDown(event, option.value)}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c6cb0] ${
                          audioMaskMode === option.value
                            ? "bg-white text-[#21194d] shadow-[0_8px_18px_-14px_rgba(15,23,42,0.8)]"
                            : "text-[#6b6384] hover:bg-white/70"
                        } ${alignmentBusy || maskingBusy || autoMaskingBusy ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleGenerateAlignment(false)}
                    disabled={alignmentBusy || maskingBusy || autoMaskingBusy || !finalTranscript.trim()}
                    className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {alignmentBusy ? "Aligning..." : "Align Words"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMaskPIIAudio(false)}
                    disabled={alignmentBusy || maskingBusy || autoMaskingBusy || (piiAnnotations.length === 0 && maskedIntervals.length === 0)}
                    className="oa-btn-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {maskingBusy ? "Masking..." : maskIntervalsDirty ? "Update Mask" : "Mask PII"}
                  </button>
                </div>
              ) : null}
            </div>
            <AudioWaveformPlayer
              audioUrl={audioUrl}
              highlightIntervals={audioMaskingEnabled ? maskedIntervals : []}
              referenceIntervals={audioMaskingEnabled ? alignmentMaskIntervals : []}
              editableIntervals={audioMaskingEnabled && maskedIntervals.length > 0}
              onIntervalsChange={handleMaskIntervalsChange}
            />
            {alignmentMessage ? (
              <p className="mt-2 rounded-lg border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2 text-xs text-[#4b5563]">
                {alignmentMessage}
              </p>
            ) : null}
            {audioGroup && audioGroup.chunk_count > 1 ? (
              <div className="mt-3 rounded-xl border border-[#d9d2ef] bg-[#fbf8ff] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#4f4674]">Full Recording Review</p>
                    <p className="mt-0.5 text-xs text-[#6b6682]">
                      {audioGroup.group_label ?? "Recording"} | chunk {audioGroup.current_position}/{audioGroup.chunk_count}
                      {audioGroup.missing_transcript_count > 0
                        ? ` | ${audioGroup.missing_transcript_count} segment transcript${audioGroup.missing_transcript_count === 1 ? "" : "s"} missing`
                        : " | all segment transcripts present"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFullReviewToggle()}
                    className="oa-btn-secondary px-3 py-1.5 text-xs font-semibold"
                  >
                    {fullReviewOpen ? "Hide full audio" : "Review full audio"}
                  </button>
                </div>
                {fullReviewOpen ? (
                  <div className="mt-3 space-y-3">
                    {fullAudioUrl ? (
                      <audio
                        controls
                        controlsList="nodownload"
                        preload="metadata"
                        className="w-full"
                        onContextMenu={(event) => event.preventDefault()}
                      >
                        <source src={fullAudioUrl} />
                      </audio>
                    ) : (
                      <p className="rounded-lg border border-[#f0c8c8] bg-white px-3 py-2 text-sm text-[#a13a3a]">
                        {audioGroup.message ?? "Full audio is not available for this recording."}
                      </p>
                    )}
                    <div className="grid gap-2 text-xs text-[#4f4674] sm:grid-cols-3">
                      <span className="rounded-lg border border-[#e8def5] bg-white px-3 py-2">
                        Segment words: {fullReviewComparison.referenceWordCount}
                      </span>
                      <span className="rounded-lg border border-[#e8def5] bg-white px-3 py-2">
                        Review words: {fullReviewComparison.actualWordCount}
                      </span>
                      <span
                        className={`rounded-lg border px-3 py-2 ${
                          fullReviewHasConflict
                            ? "border-[#ffd9a8] bg-[#fff8ec] text-[#925b17]"
                            : "border-[#cdebd7] bg-[#f4fff7] text-[#2f6940]"
                        }`}
                      >
                        Match: {fullReviewComparison.similarityPercent === null ? "--" : `${fullReviewComparison.similarityPercent}%`}
                      </span>
                    </div>
                    <label className="block text-xs font-semibold text-[#4f4674]">
                      Full transcript check
                      <textarea
                        value={fullReviewTranscript}
                        onChange={(event) => {
                          setFullReviewTranscript(event.target.value);
                          setFullReviewTouched(true);
                        }}
                        rows={5}
                        className="oa-textarea mt-1 bg-white font-mono text-sm"
                        placeholder="Listen to the full recording and paste or type the complete transcript here to compare against segment transcripts."
                      />
                    </label>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <select
                        value={task.id}
                        onChange={(event) => router.push(`/tasks/${event.target.value}`)}
                        className="oa-input min-w-[260px] px-3 py-2 text-xs"
                        aria-label="Open a chunk from this recording"
                      >
                        {audioGroup.chunks.map((chunk) => (
                          <option key={chunk.task_id} value={chunk.task_id}>
                            {chunk.position}. {chunk.filename} - {chunk.has_transcript ? "has transcript" : "missing transcript"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setFullReviewTouched(false);
                          setFullReviewTranscript(assembledSegmentTranscript);
                        }}
                        className="oa-btn-secondary px-3 py-2 text-xs font-semibold"
                      >
                        Use segment transcript
                      </button>
                    </div>
                    {fullReviewHasConflict ? (
                      <div className="rounded-lg border border-[#ffd9a8] bg-[#fff8ec] px-3 py-2 text-xs text-[#925b17]">
                        <p className="font-semibold">Full transcript check does not match the segment transcripts.</p>
                        <p className="mt-1">
                          Review the nearby chunks, then correct the segment transcript that caused the mismatch.
                        </p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <p>
                            Missing from full check:{" "}
                            {fullReviewComparison.missingWords.slice(0, 12).join(", ") || "none"}
                          </p>
                          <p>
                            Extra in full check: {fullReviewComparison.extraWords.slice(0, 12).join(", ") || "none"}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="rounded-lg border border-[#cdebd7] bg-[#f4fff7] px-3 py-2 text-xs text-[#2f6940]">
                        Full transcript check matches the current segment transcripts.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            {audioMaskingEnabled && maskedIntervals.length > 0 ? (
              <div className="mt-3 rounded-xl border border-[#fed7aa] bg-[#fff7ed] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9a3412]">PII Mask Windows</p>
                  {maskIntervalsDirty ? (
                    <span className="rounded-full border border-[#fdba74] bg-white px-2 py-0.5 text-xs font-medium text-[#9a3412]">
                      Adjusted
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 grid gap-2">
                  {maskedIntervals.map((interval, index) => (
                    <div
                      key={`${interval.start_seconds}-${interval.end_seconds}-${index}`}
                      className="grid grid-cols-1 gap-2 rounded-lg border border-[#fed7aa] bg-white px-3 py-2 sm:grid-cols-[minmax(0,1fr)_120px_120px]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[#111827]">{interval.labels.join(", ") || "PII"}</div>
                        <div className="truncate text-xs text-[#6b7280]">{interval.text || "No text captured"}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2 py-0.5 text-[11px] text-[#1d4ed8]">
                            Auto {formatTimestampSeconds(alignmentMaskIntervals[index]?.start_seconds)}s-
                            {formatTimestampSeconds(alignmentMaskIntervals[index]?.end_seconds)}s
                          </span>
                          <span className="rounded-full border border-[#dcfce7] bg-[#f0fdf4] px-2 py-0.5 text-[11px] text-[#166534]">
                            Accepted {formatTimestampSeconds(acceptedMaskIntervals[index]?.start_seconds ?? interval.start_seconds)}s-
                            {formatTimestampSeconds(acceptedMaskIntervals[index]?.end_seconds ?? interval.end_seconds)}s
                          </span>
                        </div>
                      </div>
                      <label className="text-xs font-medium text-[#9a3412]">
                        Start
                        <input
                          aria-label={`Mask start time for ${interval.labels.join(", ") || "PII"}`}
                          type="number"
                          min="0"
                          step="0.001"
                          value={interval.start_seconds.toFixed(3)}
                          onChange={(event) => handleMaskIntervalFieldChange(index, "start_seconds", event.target.value)}
                          className="oa-input mt-1 w-full py-1.5"
                        />
                      </label>
                      <label className="text-xs font-medium text-[#9a3412]">
                        End
                        <input
                          aria-label={`Mask end time for ${interval.labels.join(", ") || "PII"}`}
                          type="number"
                          min="0"
                          step="0.001"
                          value={interval.end_seconds.toFixed(3)}
                          onChange={(event) => handleMaskIntervalFieldChange(index, "end_seconds", event.target.value)}
                          className="oa-input mt-1 w-full py-1.5"
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {audioMaskingEnabled && maskedAudioUrl ? (
              <div className="mt-3 rounded-xl border border-[#d7eadf] bg-[#f1fbf5] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#266544]">Masked Audio Preview</p>
                    {maskedAudioMode ? (
                      <span className="rounded-full border border-[#bfe5cb] bg-white px-2 py-0.5 text-xs font-medium text-[#266544]">
                        {maskedAudioMode === "beep" ? "Beep" : "Silence"}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs text-[#266544]">
                    {maskedIntervals.length} masked span{maskedIntervals.length === 1 ? "" : "s"}
                  </span>
                </div>
                <audio
                  controls
                  controlsList="nodownload"
                  preload="metadata"
                  className="mt-2 w-full"
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <source src={maskedAudioUrl} />
                </audio>
                {maskedIntervals.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {maskedIntervals.map((interval, index) => (
                      <span key={`${interval.start_seconds}-${interval.end_seconds}-${index}`} className="rounded-full border border-[#bfe5cb] bg-white px-2 py-0.5 text-xs text-[#266544]">
                        {interval.labels.join(", ")} {formatTimestampSeconds(interval.start_seconds)}s-
                        {formatTimestampSeconds(interval.end_seconds)}s
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div data-tour-id="final-transcript" className="oa-card p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="oa-title text-sm font-semibold">Final Transcript</h3>
              <span className="text-xs text-[#6b7280]">Primary editing area</span>
            </div>
            <textarea
              ref={transcriptTextareaRef}
              aria-label="Final Transcript"
              value={finalTranscript}
              onChange={(event) => {
                setFinalTranscript(event.target.value);
                setTranscriptSelection(null);
                markSectionsUnverified(transcriptDependentSections);
                setSaveState("unsaved");
              }}
              onSelect={syncTranscriptSelection}
              onKeyUp={syncTranscriptSelection}
              onMouseUp={syncTranscriptSelection}
              onBlur={() => void saveAll()}
              rows={14}
              className="oa-textarea min-h-[460px] bg-white font-mono text-[15px]"
            />
            <div data-tour-id="word-audio-check" className="mt-3 rounded-xl border border-[#e5e7eb] bg-[#fbfcfe] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#4b5563]">Word Audio Check</p>
                <button
                  type="button"
                  onClick={() => void handleGenerateAlignment(false)}
                  disabled={alignmentBusy || maskingBusy || autoMaskingBusy || !finalTranscript.trim()}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {alignmentBusy ? "Aligning..." : alignmentWords.length ? "Refresh Alignment" : "Align Words"}
                </button>
              </div>
              {alignmentWords.length > 0 ? (
                <div className="mt-2 max-h-32 overflow-auto rounded-lg border border-[#e5e7eb] bg-white p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {alignmentWords.map((word) => (
                      <button
                        key={`${word.index}-${word.start_char}-${word.end_char}`}
                        type="button"
                        onClick={() => playAlignedWord(word)}
                        className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                          activeWordIndex === word.index
                            ? "border-[#241f43] bg-[#241f43] text-white"
                            : "border-[#e5e7eb] bg-[#f8fafc] text-[#374151] hover:border-[#c7d2fe] hover:bg-[#eef2ff]"
                        }`}
                        title={`${formatTimestampSeconds(word.start_seconds)}s - ${formatTimestampSeconds(word.end_seconds)}s`}
                      >
                        {word.text}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-2 rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">
                  Run forced alignment to play individual transcript words from the original audio.
                </p>
              )}
              <audio
                ref={wordAudioRef}
                controlsList="nodownload"
                preload="metadata"
                className="hidden"
                onContextMenu={(event) => event.preventDefault()}
                onTimeUpdate={handleWordAudioTimeUpdate}
                onEnded={() => {
                  clearWordStopTimer();
                  wordStopAtRef.current = null;
                  setActiveWordIndex(null);
                }}
              />
            </div>
          </div>
        </div>

        <aside data-tour-id="inspector-panel" className="oa-card p-3 sm:p-4">
          <div data-tour-id="inspector-tabs" className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] p-1">
            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${visibleInspectorTabs.length}, minmax(0, 1fr))` }}
            >
              {visibleInspectorTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleInspectorTabClick(tab.key)}
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                    activeInspectorPanel === tab.key
                      ? "bg-white text-[#111827] shadow-[0_8px_20px_-18px_rgba(15,23,42,0.9)]"
                      : "text-[#6b7280] hover:bg-white/70"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-[#e5e7eb] bg-[#fbfcfe] p-3">
            {activeInspectorPanel === "compare" ? (
              <div data-tour-id="inspector-compare">
                <h3 className="oa-title mb-2 text-sm font-semibold">ASR Transcript Comparison</h3>
                <TranscriptComparison
                  transcripts={task.transcript_variants}
                  onCopy={(text) => {
                    setFinalTranscript(text);
                    setTranscriptSelection(null);
                    markSectionsUnverified(transcriptDependentSections);
                    setSaveState("unsaved");
                  }}
                />
              </div>
            ) : null}

            {metadataEnabled && activeInspectorPanel === "metadata" ? (
              <div data-tour-id="inspector-metadata">
                <h3 className="oa-title mb-2 text-sm font-semibold">Metadata</h3>
                <MetadataEditor
                  value={metadata}
                  original={originalMetadata}
                  customMetadata={customMetadata}
                  originalCustomMetadata={originalCustomMetadata}
                  onCoreChange={(field, value) => {
                    setMetadata((prev) => ({ ...prev, [field]: value }));
                    markSectionsUnverified(["metadata"]);
                    setSaveState("unsaved");
                  }}
                  onCustomChange={(field, value) => {
                    setCustomMetadata((prev) => ({ ...prev, [field]: value }));
                    markSectionsUnverified(["metadata"]);
                    setSaveState("unsaved");
                  }}
                />
              </div>
            ) : null}

            {piiEnabled && activeInspectorPanel === "pii" ? (
              <div data-tour-id="inspector-pii">
                <PIIAnnotator
                  transcript={finalTranscript}
                  annotations={piiAnnotations}
                  onChange={handleChangePII}
                  onDetect={handleDetectPII}
                  onClear={() => {
                    setPiiAnnotations([]);
                    setTranscriptSelection(null);
                    setMaskedAudioUrl(null);
                    setMaskedIntervals([]);
                    setAcceptedMaskIntervals([]);
                    setAlignmentMaskIntervals([]);
                    setMaskedAudioMode(null);
                    setMaskIntervalsDirty(false);
                    markSectionsUnverified(["pii", "masking"]);
                    setSaveState("unsaved");
                  }}
                  labels={piiLabelOptions}
                  detecting={piiDetectionBusy}
                  detectionMessage={piiDetectionMessage}
                />
              </div>
            ) : null}

            {activeInspectorPanel === "notes" ? (
              <div data-tour-id="inspector-notes" className="space-y-2">
                <h3 className="oa-title text-sm font-semibold">Notes</h3>
                <textarea
                  aria-label="Notes"
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    setSaveState("unsaved");
                  }}
                  onBlur={() => void saveAll()}
                  rows={8}
                  className="oa-textarea"
                />
              </div>
            ) : null}

          </div>
        </aside>
      </div>

      {error ? (
        <div className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">
          <p>{error}</p>
          {Object.keys(sectionErrors).length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-2 text-xs">
              {Object.entries(sectionErrors).map(([section, message]) => (
                <li key={section} className="rounded-full bg-white/70 px-2 py-0.5">
                  {section}: {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <ConflictModal
        open={conflict.open}
        serverTask={conflict.serverTask}
        conflictingFields={conflict.conflictingFields}
        localValues={{
          final_transcript: finalTranscript,
          notes,
          status,
          speaker_gender: metadata.speaker_gender || null,
          speaker_role: metadata.speaker_role || null,
          language: metadata.language || null,
          channel: metadata.channel || null,
          duration_seconds: metadata.duration_seconds ? Number(metadata.duration_seconds) : null,
          custom_metadata: customMetadata,
          pii_annotations: piiAnnotations,
        }}
        onUseServer={handleUseServer}
        onUseMine={handleUseMine}
        onMerge={handleMerge}
      />
    </section>
  );
}

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
      <kbd className="rounded-md border border-[#d9d2ef] bg-[#fbf8ff] px-2 py-1 font-mono text-[11px] font-semibold text-[#241f43]">
        {keys}
      </kbd>
      <span className="text-right">{label}</span>
    </div>
  );
}

function ReviewCheck({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
      <span>{label}</span>
      <span
        className={
          ready
            ? "rounded-full border border-[#bfe7cf] bg-[#eafaf0] px-2 py-0.5 text-[11px] font-semibold text-[#236140]"
            : "rounded-full border border-[#ffd9a8] bg-[#fff8ec] px-2 py-0.5 text-[11px] font-semibold text-[#925b17]"
        }
      >
        {ready ? "Ready" : "Check"}
      </span>
    </div>
  );
}

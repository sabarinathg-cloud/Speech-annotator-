import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminHiringPage from "@/app/(dashboard)/admin/hiring/page";
import { defaultHiringInstructions } from "@/lib/hiring-instructions";

const {
  assignHiringCandidates,
  clearHiringAssignmentAudio,
  createHiringAssignmentInvite,
  createUser,
  createHiringAssessment,
  deleteHiringAssessment,
  deleteHiringAssignment,
  deleteUser,
  enqueueHiringDeepgramReferences,
  fetchHiringAssignmentAuditEvents,
  fetchHiringAssessment,
  fetchHiringAssessmentAssignments,
  fetchHiringAssignmentReview,
  fetchHiringAssessmentRanking,
  fetchHiringAssessments,
  fetchHiringAudioBuckets,
  fetchJob,
  fetchUsers,
  importHiringAssignmentFolder,
  importHiringFolder,
  importHiringManifest,
  parseHiringDeepgramReferenceResult,
  streamAdminHiringAudio,
  updateHiringAssessment,
  updateHiringAssignmentAccess,
  updateHiringItemReference,
  updateHiringScorecard,
  updateHiringSubmissionValidation,
  updateUser,
  uploadHiringAudio,
} = vi.hoisted(() => ({
  assignHiringCandidates: vi.fn(),
  clearHiringAssignmentAudio: vi.fn(),
  createHiringAssignmentInvite: vi.fn(),
  createUser: vi.fn(),
  createHiringAssessment: vi.fn(),
  deleteHiringAssessment: vi.fn(),
  deleteHiringAssignment: vi.fn(),
  deleteUser: vi.fn(),
  enqueueHiringDeepgramReferences: vi.fn(),
  fetchHiringAssignmentAuditEvents: vi.fn(),
  fetchHiringAssessment: vi.fn(),
  fetchHiringAssessmentAssignments: vi.fn(),
  fetchHiringAssignmentReview: vi.fn(),
  fetchHiringAssessmentRanking: vi.fn(),
  fetchHiringAssessments: vi.fn(),
  fetchHiringAudioBuckets: vi.fn(),
  fetchJob: vi.fn(),
  fetchUsers: vi.fn(),
  importHiringAssignmentFolder: vi.fn(),
  importHiringFolder: vi.fn(),
  importHiringManifest: vi.fn(),
  parseHiringDeepgramReferenceResult: vi.fn((result) => result),
  streamAdminHiringAudio: vi.fn(),
  updateHiringAssessment: vi.fn(),
  updateHiringAssignmentAccess: vi.fn(),
  updateHiringItemReference: vi.fn(),
  updateHiringScorecard: vi.fn(),
  updateHiringSubmissionValidation: vi.fn(),
  updateUser: vi.fn(),
  uploadHiringAudio: vi.fn(),
}));

const now = "2026-06-22T12:00:00.000Z";

const assessmentSummary = {
  id: "assessment-1",
  title: "Hiring QA",
  instructions: "Transcribe all audio",
  status: "ACTIVE",
  due_date: null,
  due_at: null,
  time_limit_minutes: 120,
  blind_review_enabled: false,
  metadata_schema: [
    {
      key: "audio_quality",
      label: "Audio quality",
      type: "select",
      required: true,
      options: ["Clean audio", "Background noise"],
      sort_order: 0,
    },
  ],
  pii_label_keys: [],
  rubric_schema: [],
  item_count: 1,
  assignment_count: 1,
  created_at: now,
  updated_at: now,
};

const assessmentItem = {
  id: "item-1",
  external_id: "audio-1",
  assignment_id: "assignment-1",
  original_filename: "sample.wav",
  original_source: "/audio/sample.wav",
  sort_order: 0,
  created_at: now,
  reference_transcript: "reference transcript",
  reference_pii_annotations: [],
  reference_pii_entries: [],
  reference_metadata: {},
};

const assignmentSummary = {
  id: "assignment-1",
  assessment_id: "assessment-1",
  assessment_title: "Hiring QA",
  candidate_id: "candidate-1",
  candidate_name: "Candidate One",
  candidate_email: "candidate@example.com",
  candidate_label: "Candidate One",
  candidate_identity_hidden: false,
  status: "SUBMITTED",
  decision: "PENDING",
  access_revoked: false,
  due_date: null,
  due_at: null,
  item_count: 1,
  submitted_count: 1,
  validated_count: 0,
  rejected_count: 0,
  assigned_at: now,
  started_at: now,
  submitted_at: now,
  evaluated_at: null,
  time_limit_expires_at: null,
  submission_deadline_at: null,
  seconds_remaining: null,
  last_saved_at: now,
  invite_url: null,
  invite_expires_at: null,
  total_score: null,
};

const earlySubmittedAssignment = {
  ...assignmentSummary,
  id: "assignment-2",
  candidate_id: "candidate-2",
  candidate_name: "Candidate Two",
  candidate_email: "candidate-two@example.com",
  candidate_label: "Candidate Two",
  submitted_at: "2026-06-22T10:00:00.000Z",
  last_saved_at: "2026-06-22T10:05:00.000Z",
  total_score: 8,
};

const reviewResponse = {
  id: "assignment-1",
  assessment: assessmentSummary,
  candidate_id: "candidate-1",
  candidate_name: "Candidate One",
  candidate_email: "candidate@example.com",
  status: "SUBMITTED",
  decision: "PENDING",
  access_revoked: false,
  started_at: now,
  submitted_at: now,
  time_limit_expires_at: null,
  submission_deadline_at: null,
  seconds_remaining: null,
  transcript_score: null,
  pii_score: null,
  metadata_score: null,
  total_score: null,
  rubric_scores: {},
  evaluator_notes: null,
  items: [assessmentItem],
  submissions: [
    {
      id: "submission-1",
      item_id: "item-1",
      version: 2,
      final_transcript: "hello my phone number is 555 0100",
      pii_annotations: [],
      pii_text: "Phone number: 555 0100",
      pii_entries: [{ type: "PHONE", value: "555 0100", timestamp: "00:04", notes: "spoken by caller" }],
      metadata_values: { audio_quality: "Clean audio" },
      notes: "Clear speech",
      pii_reviewed: true,
      validation_status: "PENDING",
      validation_feedback: null,
      last_saved_at: now,
      submitted_at: now,
      reference_metrics: null,
    },
  ],
};

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "admin-token",
    user: {
      id: "admin-1",
      email: "admin@example.com",
      full_name: "Admin",
      role: "ADMIN",
    },
  }),
}));

vi.mock("@/components/audio-waveform-player", () => ({
  AudioWaveformPlayer: ({ audioUrl }: { audioUrl: string | null }) => (
    <div data-testid="admin-audio-player">{audioUrl ? "Audio ready" : "Audio not available"}</div>
  ),
}));

vi.mock("@/lib/api", () => ({
  APIError: class APIError extends Error {
    status: number;
    payload: unknown;
    constructor(message: string, status: number, payload: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  },
  assignHiringCandidates: (...args: unknown[]) => assignHiringCandidates(...args),
  clearHiringAssignmentAudio: (...args: unknown[]) => clearHiringAssignmentAudio(...args),
  createHiringAssignmentInvite: (...args: unknown[]) => createHiringAssignmentInvite(...args),
  createUser: (...args: unknown[]) => createUser(...args),
  createHiringAssessment: (...args: unknown[]) => createHiringAssessment(...args),
  deleteHiringAssessment: (...args: unknown[]) => deleteHiringAssessment(...args),
  deleteHiringAssignment: (...args: unknown[]) => deleteHiringAssignment(...args),
  deleteUser: (...args: unknown[]) => deleteUser(...args),
  enqueueHiringDeepgramReferences: (...args: unknown[]) => enqueueHiringDeepgramReferences(...args),
  fetchHiringAssignmentAuditEvents: (...args: unknown[]) => fetchHiringAssignmentAuditEvents(...args),
  fetchHiringAssessment: (...args: unknown[]) => fetchHiringAssessment(...args),
  fetchHiringAssessmentAssignments: (...args: unknown[]) => fetchHiringAssessmentAssignments(...args),
  fetchHiringAssignmentReview: (...args: unknown[]) => fetchHiringAssignmentReview(...args),
  fetchHiringAssessmentRanking: (...args: unknown[]) => fetchHiringAssessmentRanking(...args),
  fetchHiringAssessments: (...args: unknown[]) => fetchHiringAssessments(...args),
  fetchHiringAudioBuckets: (...args: unknown[]) => fetchHiringAudioBuckets(...args),
  fetchJob: (...args: unknown[]) => fetchJob(...args),
  fetchUsers: (...args: unknown[]) => fetchUsers(...args),
  importHiringAssignmentFolder: (...args: unknown[]) => importHiringAssignmentFolder(...args),
  importHiringFolder: (...args: unknown[]) => importHiringFolder(...args),
  importHiringManifest: (...args: unknown[]) => importHiringManifest(...args),
  parseHiringDeepgramReferenceResult: (...args: unknown[]) => parseHiringDeepgramReferenceResult(...args),
  streamAdminHiringAudio: (...args: unknown[]) => streamAdminHiringAudio(...args),
  updateHiringAssessment: (...args: unknown[]) => updateHiringAssessment(...args),
  updateHiringAssignmentAccess: (...args: unknown[]) => updateHiringAssignmentAccess(...args),
  updateHiringItemReference: (...args: unknown[]) => updateHiringItemReference(...args),
  updateHiringScorecard: (...args: unknown[]) => updateHiringScorecard(...args),
  updateHiringSubmissionValidation: (...args: unknown[]) => updateHiringSubmissionValidation(...args),
  updateUser: (...args: unknown[]) => updateUser(...args),
  uploadHiringAudio: (...args: unknown[]) => uploadHiringAudio(...args),
}));

describe("AdminHiringPage candidate answers", () => {
  beforeEach(() => {
    fetchHiringAssessments.mockResolvedValue({ items: [assessmentSummary] });
    fetchUsers.mockResolvedValue({ items: [] });
    fetchHiringAssessment.mockResolvedValue({ ...assessmentSummary, items: [assessmentItem] });
    fetchHiringAssessmentAssignments.mockResolvedValue({ items: [assignmentSummary] });
    fetchHiringAssessmentRanking.mockResolvedValue({ items: [] });
    fetchHiringAssignmentReview.mockResolvedValue(reviewResponse);
    fetchHiringAssignmentAuditEvents.mockResolvedValue({ items: [] });
    createHiringAssessment.mockResolvedValue({ ...assessmentSummary, id: "assessment-new" });
    streamAdminHiringAudio.mockResolvedValue({
      blob: new Blob(["audio"], { type: "audio/wav" }),
      filename: "sample.wav",
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:admin-audio"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens candidate answers with transcript, PII, metadata, and notes from the progress table", async () => {
    render(<AdminHiringPage />);

    const answersButton = await screen.findByRole("button", { name: "Answers" });
    fireEvent.click(answersButton);

    const drawer = await screen.findByRole("dialog", { name: "Candidate One" });
    expect(within(drawer).getByText("Candidate answers")).toBeInTheDocument();
    expect(within(drawer).getByText("hello my phone number is 555 0100")).toBeInTheDocument();
    expect(within(drawer).getByText("PHONE: 555 0100")).toBeInTheDocument();
    expect(within(drawer).getByText("Clean audio")).toBeInTheDocument();
    expect(within(drawer).getByText("Clear speech")).toBeInTheDocument();
    expect(await within(drawer).findByText("Audio ready")).toBeInTheDocument();
    expect(streamAdminHiringAudio).toHaveBeenCalledWith("admin-token", "assignment-1", "item-1");
  });

  it("sorts candidate progress by submitted time", async () => {
    fetchHiringAssessmentAssignments.mockResolvedValue({ items: [assignmentSummary, earlySubmittedAssignment] });

    render(<AdminHiringPage />);

    const table = await screen.findByRole("table", { name: "Candidate progress" });
    await waitFor(() => expect(within(table).getByText("Candidate Two")).toBeInTheDocument());

    let rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Candidate Two")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Candidate One")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sort candidate progress"), {
      target: { value: "submitted_latest" },
    });

    rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Candidate One")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Candidate Two")).toBeInTheDocument();
  });

  it("prefills new assessments with candidate instructions", async () => {
    render(<AdminHiringPage />);

    const instructionFields = await screen.findAllByPlaceholderText("Candidate instructions");
    expect(instructionFields[0]).toHaveValue(defaultHiringInstructions);
  });

  it("keeps commas and special characters in select metadata options", async () => {
    render(<AdminHiringPage />);

    const optionEditor = await screen.findByPlaceholderText(/One option per line/);
    fireEvent.change(optionEditor, {
      target: {
        value: "Clean audio, mild noise\nBackground speaker / crosstalk (low)\nNeeds review #1",
      },
    });
    fireEvent.change(screen.getByPlaceholderText("Assessment title"), {
      target: { value: "Special metadata options" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createHiringAssessment).toHaveBeenCalled());
    expect(createHiringAssessment).toHaveBeenCalledWith(
      "admin-token",
      expect.objectContaining({
        metadata_schema: expect.arrayContaining([
          expect.objectContaining({
            key: "audio_quality",
            options: [
              "Clean audio, mild noise",
              "Background speaker / crosstalk (low)",
              "Needs review #1",
            ],
          }),
        ]),
      })
    );
  });

  it("starts Deepgram reference generation from audio references", async () => {
    enqueueHiringDeepgramReferences.mockResolvedValue({ job_id: "deepgram-job-1", status: "COMPLETED" });
    fetchJob.mockResolvedValue({
      id: "deepgram-job-1",
      job_id: "deepgram-job-1",
      job_type: "hiring_deepgram_references",
      status: "COMPLETED",
      payload: {},
      result: {
        assessment_id: "assessment-1",
        processed_items: 1,
        transcribed_items: 1,
        skipped_items: 0,
        errors: [],
      },
      error_message: null,
      output_available: false,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: now,
    });

    render(<AdminHiringPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Audio & References" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate with Deepgram" }));

    await waitFor(() =>
      expect(enqueueHiringDeepgramReferences).toHaveBeenCalledWith("admin-token", "assessment-1", {
        overwrite_existing: false,
      })
    );
    expect(await screen.findByText("Deepgram generated 1 reference transcript")).toBeInTheDocument();
  });
});

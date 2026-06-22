import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CandidateHiringAssignmentPage from "@/app/(dashboard)/hiring/[assignmentId]/page";

const {
  fetchCandidateHiringAssignment,
  patchCandidateHiringSubmission,
  downloadCandidateHiringAudio,
  downloadCandidateHiringZip,
  submitCandidateHiringAssignment,
} = vi.hoisted(() => ({
  fetchCandidateHiringAssignment: vi.fn(),
  patchCandidateHiringSubmission: vi.fn(),
  downloadCandidateHiringAudio: vi.fn(),
  downloadCandidateHiringZip: vi.fn(),
  submitCandidateHiringAssignment: vi.fn(),
}));

const now = "2026-06-22T12:00:00.000Z";

function buildAssignment(overrides: Record<string, unknown> = {}) {
  const submission = {
    id: "submission-1",
    item_id: "item-1",
    version: 1,
    final_transcript: "",
    pii_annotations: [],
    pii_text: "",
    pii_entries: [],
    metadata_values: {},
    notes: "",
    pii_reviewed: false,
    validation_status: "PENDING",
    validation_feedback: null,
    last_saved_at: null,
    submitted_at: null,
    reference_metrics: null,
  };

  return {
    id: "assignment-1",
    assessment: {
      id: "assessment-1",
      title: "Hiring QA",
      instructions: "",
      status: "ACTIVE",
      due_date: null,
      due_at: null,
      time_limit_minutes: null,
      blind_review_enabled: true,
      metadata_schema: [],
      pii_label_keys: [],
      rubric_schema: [],
      item_count: 1,
      assignment_count: 1,
      created_at: now,
      updated_at: now,
    },
    status: "IN_PROGRESS",
    decision: "PENDING",
    access_revoked: false,
    started_at: now,
    submitted_at: null,
    time_limit_expires_at: null,
    submission_deadline_at: null,
    seconds_remaining: null,
    items: [
      {
        id: "item-1",
        external_id: "audio-1",
        assignment_id: "assignment-1",
        original_filename: "sample.wav",
        original_source: "/audio/sample.wav",
        sort_order: 0,
        created_at: now,
        reference_transcript: null,
        reference_pii_annotations: [],
        reference_pii_entries: [],
        reference_metadata: {},
      },
    ],
    submissions: [submission],
    ...overrides,
  };
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ assignmentId: "assignment-1" }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "test-token",
    user: {
      id: "candidate-1",
      email: "candidate@example.com",
      full_name: "Candidate",
      role: "CANDIDATE",
    },
  }),
}));

vi.mock("@/components/audio-waveform-player", () => ({
  AudioWaveformPlayer: ({ audioUrl }: { audioUrl: string | null }) => (
    <div data-testid="audio-player">{audioUrl ? "Audio ready" : "Audio not available"}</div>
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
  fetchCandidateHiringAssignment: (...args: unknown[]) => fetchCandidateHiringAssignment(...args),
  patchCandidateHiringSubmission: (...args: unknown[]) => patchCandidateHiringSubmission(...args),
  downloadCandidateHiringAudio: (...args: unknown[]) => downloadCandidateHiringAudio(...args),
  downloadCandidateHiringZip: (...args: unknown[]) => downloadCandidateHiringZip(...args),
  submitCandidateHiringAssignment: (...args: unknown[]) => submitCandidateHiringAssignment(...args),
}));

describe("CandidateHiringAssignmentPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    fetchCandidateHiringAssignment.mockResolvedValue(buildAssignment());
    downloadCandidateHiringAudio.mockResolvedValue({
      blob: new Blob(["audio"], { type: "audio/wav" }),
      filename: "sample.wav",
    });
    downloadCandidateHiringZip.mockResolvedValue({
      blob: new Blob(["zip"], { type: "application/zip" }),
      filename: "assignment.zip",
    });
    submitCandidateHiringAssignment.mockResolvedValue(buildAssignment({ status: "SUBMITTED" }));
    patchCandidateHiringSubmission.mockImplementation((_token, _submissionId, payload) => {
      const assignment = buildAssignment();
      assignment.submissions[0] = {
        ...assignment.submissions[0],
        ...payload,
        version: 2,
        last_saved_at: now,
      };
      return Promise.resolve(assignment);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:audio"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("makes PII review obvious and auto-saves the reviewed flag", async () => {
    render(<CandidateHiringAssignmentPage />);

    expect(await screen.findByText("PII review required")).toBeInTheDocument();
    const reviewButton = screen.getByRole("button", { name: "Mark PII reviewed" });

    vi.useFakeTimers();
    fireEvent.click(reviewButton);

    expect(screen.getByText("PII review complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reviewed" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Changes will auto-save shortly")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1900);
      await Promise.resolve();
    });

    expect(patchCandidateHiringSubmission).toHaveBeenCalledWith(
      "test-token",
      "submission-1",
      expect.objectContaining({
        version: 1,
        pii_reviewed: true,
      })
    );
  });

  it("returns PII review to required when the candidate edits PII details", async () => {
    render(<CandidateHiringAssignmentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark PII reviewed" }));
    expect(screen.getByText("PII review complete")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Additional PII notes"), {
      target: { value: "Phone number mentioned near the end" },
    });

    expect(screen.getByText("PII review required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark PII reviewed" })).toHaveAttribute("aria-pressed", "false");
  });
});

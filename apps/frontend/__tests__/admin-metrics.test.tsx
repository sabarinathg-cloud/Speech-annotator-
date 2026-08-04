import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminMetricsPage from "@/app/(dashboard)/admin/metrics/page";

const {
  createPIILabel,
  fetchAdminMetrics,
  fetchAdminPIILabels,
  fetchUsers,
  updatePIILabel,
} = vi.hoisted(() => ({
  createPIILabel: vi.fn(),
  fetchAdminMetrics: vi.fn(),
  fetchAdminPIILabels: vi.fn(),
  fetchUsers: vi.fn(),
  updatePIILabel: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "test-token",
    user: {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
    },
  }),
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
  createPIILabel: (...args: unknown[]) => createPIILabel(...args),
  fetchAdminMetrics: (...args: unknown[]) => fetchAdminMetrics(...args),
  fetchAdminPIILabels: (...args: unknown[]) => fetchAdminPIILabels(...args),
  fetchUsers: (...args: unknown[]) => fetchUsers(...args),
  updatePIILabel: (...args: unknown[]) => updatePIILabel(...args),
}));

describe("AdminMetricsPage", () => {
  beforeEach(() => {
    fetchUsers.mockResolvedValue({
      items: [
        {
          id: "annotator-1",
          email: "annotator@test.com",
          full_name: "Annotator",
          role: "ANNOTATOR",
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    fetchAdminPIILabels.mockResolvedValue({
      items: [
        {
          id: "label-1",
          key: "NAME",
          display_name: "Name",
          color: "#a16207",
          description: null,
          is_active: true,
          sort_order: 10,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    fetchAdminMetrics.mockResolvedValue({
      generated_at: new Date().toISOString(),
      filters: {
        status: null,
        assignee_id: null,
        job_id: null,
        language: null,
        date_from: null,
        date_to: null,
      },
      overview: {
        total_tasks: 2,
        scored_tasks: 1,
        scored_pairs: 2,
        average_wer: 0.125,
        average_cer: 0.05,
        total_pii_annotations: 3,
        low_confidence_annotations: 1,
        overlap_warnings: 0,
      },
      status_counts: { "In Progress": 1, Approved: 1 },
      model_metrics: [
        {
          source_key: "model_1",
          source_label: "Model 1",
          tasks_scored: 1,
          word_errors: 1,
          reference_words: 8,
          character_errors: 3,
          reference_characters: 60,
          average_wer: 0.125,
          average_cer: 0.05,
        },
      ],
      model_benchmarks: {
        best_model_source_key: "model_1",
        best_model_source_label: "Model 1",
        best_model_average_wer: 0.125,
        ranking: [
          {
            source_key: "model_1",
            source_label: "Model 1",
            tasks_scored: 1,
            average_wer: 0.125,
            average_cer: 0.05,
            rank: 1,
            group_key: null,
            group_label: null,
          },
        ],
        by_language: [
          {
            source_key: "model_1",
            source_label: "Model 1",
            tasks_scored: 1,
            average_wer: 0.125,
            average_cer: 0.05,
            rank: 1,
            group_key: "en",
            group_label: "en",
          },
        ],
        by_duration_bucket: [
          {
            source_key: "model_1",
            source_label: "Model 1",
            tasks_scored: 1,
            average_wer: 0.125,
            average_cer: 0.05,
            rank: 1,
            group_key: "unknown",
            group_label: "Unknown Duration",
          },
        ],
      },
      pii_metrics: {
        total_annotations: 3,
        average_annotations_per_task: 1.5,
        low_confidence_annotations: 1,
        overlap_warnings: 0,
        by_label: { NAME: 2, EMAIL: 1 },
        by_source: { manual: 2, auto: 1 },
      },
      masking_metrics: {
        masked_tasks: 3,
        scored_masked_tasks: 2,
        scored_intervals: 4,
        average_onset_error_ms: 120,
        average_offset_error_ms: 180,
        leaked_audio_duration_ms: 240,
        over_masked_duration_ms: 90,
        unscored_masked_tasks: 1,
        alignment_adjusted_tasks: 1,
        alignment_adjusted_intervals: 2,
        average_alignment_onset_adjustment_ms: 40,
        average_alignment_offset_adjustment_ms: 60,
        alignment_trimmed_duration_ms: 120,
        alignment_expanded_duration_ms: 30,
      },
      tagger_metrics: [
        {
          user_id: "annotator-1",
          user_name: "Annotator",
          user_email: "annotator@test.com",
          tasks_touched: 1,
          completed_tasks: 1,
          reviewed_tasks: 0,
          approved_tasks: 0,
          pii_annotations: 3,
        },
      ],
      user_metrics: [
        {
          user_id: "annotator-1",
          user_name: "Annotator",
          user_email: "annotator@test.com",
          role: "ANNOTATOR",
          is_active: true,
          assigned_tasks: 4,
          open_assigned_tasks: 2,
          tasks_touched: 1,
          completed_tasks: 1,
          reviewed_tasks: 0,
          approved_tasks: 0,
          pii_annotations: 3,
          average_completion_minutes: 18,
          completed_turnaround_count: 1,
          task_audit_events: 5,
          security_events: 2,
          high_risk_security_events: 1,
          last_login_at: new Date("2026-05-08T08:00:00Z").toISOString(),
          last_activity_at: new Date("2026-05-08T09:15:00Z").toISOString(),
          active_session_started_at: new Date("2026-05-08T08:00:00Z").toISOString(),
          active_session_minutes: 75,
          idle_minutes: 5,
        },
      ],
      worst_tasks: [
        {
          task_id: "task-1",
          external_id: "ROW-001",
          status: "In Progress",
          language: "en",
          upload_job_id: "upload-1",
          assignee_name: "Annotator",
          last_tagger_name: "Annotator",
          max_wer: 0.125,
          average_wer: 0.125,
          source_metrics: [
            {
              source_key: "model_1",
              source_label: "Model 1",
              wer: 0.125,
              cer: 0.05,
              word_errors: 1,
              reference_words: 8,
              character_errors: 3,
              reference_characters: 60,
            },
          ],
        },
      ],
      worst_masking_tasks: [
        {
          task_id: "task-2",
          external_id: "MASK-002",
          status: "Needs Review",
          language: "en",
          upload_job_id: "upload-1",
          assignee_name: "Annotator",
          last_tagger_name: "Annotator",
          onset_error_ms: 300,
          offset_error_ms: 400,
          leaked_audio_duration_ms: 500,
          over_masked_duration_ms: 200,
          risk_duration_ms: 700,
          scored_intervals: 1,
          alignment_adjustment_ms: 100,
          alignment_trimmed_duration_ms: 80,
          alignment_expanded_duration_ms: 20,
        },
      ],
      masking_interval_drilldowns: [
        {
          task_id: "task-2",
          external_id: "MASK-002",
          label: "PHONE",
          text: "555-0100",
          actual_start_seconds: 1,
          actual_end_seconds: 1.6,
          accepted_start_seconds: 1.1,
          accepted_end_seconds: 1.5,
          alignment_start_seconds: 1.05,
          alignment_end_seconds: 1.56,
          onset_error_ms: 100,
          offset_error_ms: 100,
          leaked_audio_duration_ms: 0,
          over_masked_duration_ms: 200,
          alignment_onset_delta_ms: 50,
          alignment_offset_delta_ms: -60,
          alignment_trimmed_duration_ms: 110,
          alignment_expanded_duration_ms: 0,
          risk_duration_ms: 200,
        },
      ],
    });
    createPIILabel.mockResolvedValue({});
    updatePIILabel.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders model, PII, and tagger metrics", async () => {
    render(<AdminMetricsPage />);

    expect(await screen.findByText("Model Accuracy")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("12.5%").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("5.0%").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Model 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Annotator").length).toBeGreaterThan(0);
    expect(screen.getByText("User Productivity Metrics")).toBeInTheDocument();
    expect(screen.getByText(/Turnaround 18 min/)).toBeInTheDocument();
    expect(screen.getByText(/Session 75 min/)).toBeInTheDocument();
    expect(screen.getByText("ROW-001")).toBeInTheDocument();
  });

  it("uses animated values for metrics numbers", async () => {
    render(<AdminMetricsPage />);

    expect(await screen.findByText("Model Accuracy")).toBeInTheDocument();
    expect(screen.getAllByTestId("animated-metric-number").length).toBeGreaterThan(8);
  });

  it("renders audio masking quality metrics without dummy values", async () => {
    render(<AdminMetricsPage />);

    expect(await screen.findByText("Audio Masking Quality")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("120 ms").length).toBeGreaterThan(0));
    expect(screen.getByText("Leaked Audio")).toBeInTheDocument();
    expect(screen.getByText("Over-Masked Audio")).toBeInTheDocument();
    expect(screen.getByText("2 scored / 1 unscored masked tasks")).toBeInTheDocument();
    expect(screen.getByText("Auto Alignment Adjustment")).toBeInTheDocument();
    expect(screen.getByText("Masking Metric Drilldown")).toBeInTheDocument();
    expect(screen.getByText("Highest Masking Risk Tasks")).toBeInTheDocument();
    expect(screen.getAllByText("MASK-002").length).toBeGreaterThan(0);
    expect(screen.queryByText(/dummy/i)).not.toBeInTheDocument();
  });

  it("renders real model benchmarking rankings", async () => {
    render(<AdminMetricsPage />);

    expect(await screen.findByText("Model Benchmarking")).toBeInTheDocument();
    expect(screen.getByText("Best Model")).toBeInTheDocument();
    expect(screen.getAllByText("Model 1").length).toBeGreaterThan(1);
    expect(screen.getByText("Overall Ranking")).toBeInTheDocument();
    expect(screen.getByText("By Language")).toBeInTheDocument();
    expect(screen.getByText("By Duration")).toBeInTheDocument();
  });

  it("creates admin-managed PII labels for annotator dropdowns", async () => {
    render(<AdminMetricsPage />);
    await screen.findByText("PII Label Management");

    fireEvent.change(screen.getByLabelText("New label key"), { target: { value: "passport" } });
    fireEvent.change(screen.getByLabelText("New label name"), { target: { value: "Passport" } });
    fireEvent.change(screen.getByLabelText("New label description"), {
      target: { value: "Government passport identifier" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));

    await waitFor(() =>
      expect(createPIILabel).toHaveBeenCalledWith("test-token", {
        key: "PASSPORT",
        display_name: "Passport",
        color: "#0f766e",
        description: "Government passport identifier",
      })
    );
  });
});

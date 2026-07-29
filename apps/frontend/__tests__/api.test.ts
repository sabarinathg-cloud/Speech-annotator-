import { describe, expect, it, vi } from "vitest";

import {
  APIError,
  acknowledgeConfidentiality,
  bulkAutoBalanceTasks,
  bulkUpdateTaskDueDates,
  bulkUpdateTaskStatuses,
  changeOwnPassword,
  detectTaskPII,
  downloadTaskExport,
  fetchAdminMetrics,
  fetchCurrentUser,
  fetchSecurityAuditEvents,
  logClientSecurityEvent,
  maskTaskPIIAudio,
  fetchTasks,
  fetchUsers,
  login,
  resetUserPassword,
  startTask,
  updateUser,
} from "@/lib/api";
import { readSession, writeSession } from "@/lib/session";

describe("API client error handling", () => {
  it("wraps non-JSON error responses in APIError", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream unavailable", {
        status: 502,
        statusText: "Bad Gateway",
      })
    );

    await expect(login("admin@test.com", "password")).rejects.toMatchObject({
      name: "APIError",
      status: 502,
      message: "Bad Gateway",
    });

    fetchMock.mockRestore();
  });

  it("refreshes tokens and retries one authenticated request", async () => {
    writeSession("old-access", "old-refresh", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "expired" }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            token_type: "bearer",
            user: {
              id: "user-1",
              email: "annotator@test.com",
              full_name: "Annotator",
              role: "ANNOTATOR",
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [], page: 1, page_size: 25, total: 0, status_counts: {} }),
          { status: 200 }
        )
      );

    await expect(fetchTasks("old-access", { page: 1 })).resolves.toMatchObject({ total: 0 });
    expect(readSession().accessToken).toBe("new-access");
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer new-access");

    fetchMock.mockRestore();
  });

  it("sends bulk task action payloads and selected export IDs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ updated: [], errors: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ updated: [], errors: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ matched_count: 10, updated_count: 10, skipped_count: 0, assignee_count: 2 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response("task_id\n", {
          status: 200,
          headers: { "Content-Disposition": 'attachment; filename="selected.csv"' },
        })
      );

    await bulkUpdateTaskDueDates("admin-token", [
      { task_id: "task-1", version: 4, due_date: "2026-05-20" },
    ]);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe("/api/v1/tasks/bulk-due-date");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      updates: [{ task_id: "task-1", version: 4, due_date: "2026-05-20" }],
    });

    await bulkUpdateTaskStatuses("admin-token", {
      status: "In Progress",
      comment: "Batch move",
      updates: [{ task_id: "task-1", version: 5 }],
    });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe("/api/v1/tasks/bulk-status");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      status: "In Progress",
      comment: "Batch move",
      updates: [{ task_id: "task-1", version: 5 }],
    });

    await bulkAutoBalanceTasks("admin-token", {
      filters: { status: "Not Started", assignee_id: "unassigned" },
      assignee_ids: ["user-1", "user-2"],
      max_tasks: 50000,
    });
    expect(new URL(String(fetchMock.mock.calls[2]?.[0])).pathname).toBe("/api/v1/tasks/bulk-auto-balance");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      filters: { status: "Not Started", assignee_id: "unassigned" },
      assignee_ids: ["user-1", "user-2"],
      max_tasks: 50000,
    });

    await expect(
      downloadTaskExport("admin-token", { format: "csv", taskIds: ["task-1", "task-2"] })
    ).resolves.toMatchObject({ filename: "selected.csv" });
    const exportUrl = new URL(String(fetchMock.mock.calls[3]?.[0]));
    expect(exportUrl.pathname).toBe("/api/v1/exports/tasks");
    expect(exportUrl.searchParams.getAll("task_ids")).toEqual(["task-1", "task-2"]);

    fetchMock.mockRestore();
  });

  it("clears the session when refresh fails", async () => {
    writeSession("old-access", "bad-refresh", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "expired" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "invalid refresh" }), { status: 401 }));

    await expect(fetchTasks("old-access", { page: 1 })).rejects.toMatchObject({ status: 401 });
    expect(readSession().accessToken).toBeNull();
    expect(readSession().refreshToken).toBeNull();

    fetchMock.mockRestore();
  });

  it("sends admin metrics filters using backend query names", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          generated_at: new Date().toISOString(),
          filters: {},
          overview: {},
          status_counts: {},
          model_metrics: [],
          model_benchmarks: {
            best_model_source_key: null,
            best_model_source_label: null,
            best_model_average_wer: null,
            ranking: [],
            by_language: [],
            by_duration_bucket: [],
          },
          pii_metrics: {},
          masking_metrics: {
            masked_tasks: 0,
            scored_masked_tasks: 0,
            scored_intervals: 0,
            average_onset_error_ms: null,
            average_offset_error_ms: null,
            leaked_audio_duration_ms: 0,
            over_masked_duration_ms: 0,
            unscored_masked_tasks: 0,
            alignment_adjusted_tasks: 0,
            alignment_adjusted_intervals: 0,
            average_alignment_onset_adjustment_ms: null,
            average_alignment_offset_adjustment_ms: null,
            alignment_trimmed_duration_ms: 0,
            alignment_expanded_duration_ms: 0,
          },
          tagger_metrics: [],
          user_metrics: [],
          worst_tasks: [],
          worst_masking_tasks: [],
          masking_interval_drilldowns: [],
        }),
        { status: 200 }
      )
    );

    await fetchAdminMetrics("admin-token", {
      status: "Approved",
      assigneeId: "unassigned",
      jobId: "upload-1",
      language: "en",
      dateFrom: "2026-04-01",
      dateTo: "2026-04-24",
      organizationId: "org-iris2",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(url.pathname).toBe("/api/v1/metrics/admin");
    expect(url.searchParams.get("status")).toBe("Approved");
    expect(url.searchParams.get("assignee_id")).toBe("unassigned");
    expect(url.searchParams.get("job_id")).toBe("upload-1");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("date_from")).toBe("2026-04-01");
    expect(url.searchParams.get("date_to")).toBe("2026-04-24");
    expect(headers.get("X-Organization-ID")).toBe("org-iris2");

    fetchMock.mockRestore();
  });

  it("sends user management filters and update requests", async () => {
    const userPayload = {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      is_active: true,
      last_login_at: null,
      last_activity_at: null,
      assigned_task_count: 0,
      open_assigned_task_count: 0,
      completed_task_count: 0,
      approved_task_count: 0,
      assignment_load: "none",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [userPayload] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...userPayload, role: "REVIEWER" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(userPayload), { status: 200 }));

    await fetchUsers("admin-token", {
      search: "annotator",
      role: "ANNOTATOR",
      status: "active",
    });
    await updateUser("admin-token", "user-1", { role: "REVIEWER", is_active: false });
    await resetUserPassword("admin-token", "user-1", "NewPass@123");

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe("/api/v1/users");
    expect(listUrl.searchParams.get("search")).toBe("annotator");
    expect(listUrl.searchParams.get("role")).toBe("ANNOTATOR");
    expect(listUrl.searchParams.get("status")).toBe("active");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/v1/users/user-1");
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/api/v1/users/user-1/reset-password");

    fetchMock.mockRestore();
  });

  it("starts a task through the backend workflow endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ task: { id: "task-1", status: "In Progress" } }), { status: 200 })
    );

    await expect(startTask("annotator-token", "task-1")).resolves.toMatchObject({
      task: { id: "task-1", status: "In Progress" },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/tasks/task-1/start");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    fetchMock.mockRestore();
  });

  it("acknowledges the confidentiality notice through the auth endpoint", async () => {
    const acknowledgedAt = new Date().toISOString();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "bearer",
          user: {
            id: "user-1",
            email: "annotator@test.com",
            full_name: "Annotator",
            role: "ANNOTATOR",
            confidentiality_acknowledged_at: acknowledgedAt,
            confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
          },
        }),
        { status: 200 }
      )
    );

    await expect(acknowledgeConfidentiality("access-token")).resolves.toMatchObject({
      user: {
        confidentiality_acknowledged_at: acknowledgedAt,
        confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/auth/confidentiality-acknowledgement");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe(
      "Bearer access-token"
    );
    fetchMock.mockRestore();
  });

  it("changes the signed-in user's password through the auth endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Password changed. Sign in with your new password." }), { status: 200 })
    );

    await expect(
      changeOwnPassword("access-token", {
        current_password: "OldPass@123",
        new_password: "NewPass@123",
      })
    ).resolves.toEqual({ message: "Password changed. Sign in with your new password." });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/auth/change-password");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer access-token");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ current_password: "OldPass@123", new_password: "NewPass@123" })
    );
    fetchMock.mockRestore();
  });

  it("fetches the current session user through the auth endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "user-1",
          email: "annotator@test.com",
          full_name: "Annotator",
          role: "ANNOTATOR",
          confidentiality_acknowledged_at: new Date().toISOString(),
          confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
        }),
        { status: 200 }
      )
    );

    await expect(fetchCurrentUser("access-token")).resolves.toMatchObject({
      email: "annotator@test.com",
      role: "ANNOTATOR",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/auth/me");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer access-token");
    fetchMock.mockRestore();
  });

  it("fetches admin security audit events with filters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "event-1",
              action: "EXPORT_TASKS",
              risk_level: "high",
              actor_email: "admin@test.com",
              actor_role: "ADMIN",
              resource_type: "export",
              resource_id: null,
              task_id: null,
              ip_address: "127.0.0.1",
              user_agent: "vitest",
              metadata: { format: "csv" },
              created_at: new Date().toISOString(),
            },
          ],
          page: 1,
          page_size: 25,
          total: 1,
        }),
        { status: 200 }
      )
    );

    await fetchSecurityAuditEvents("admin-token", {
      action: "EXPORT_TASKS",
      riskLevel: "high",
      page: 2,
      pageSize: 10,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/security/audit-events");
    expect(url.searchParams.get("action")).toBe("EXPORT_TASKS");
    expect(url.searchParams.get("risk_level")).toBe("high");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("page_size")).toBe("10");
    fetchMock.mockRestore();
  });

  it("logs client-side security events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "event-1",
          action: "ATTEMPT_PRINT",
          risk_level: "high",
          actor_email: "annotator@test.com",
          actor_role: "ANNOTATOR",
          resource_type: "client_security",
          resource_id: "user-1",
          task_id: null,
          ip_address: "127.0.0.1",
          user_agent: "vitest",
          metadata: { route: "/tasks/task-1" },
          created_at: new Date().toISOString(),
        }),
        { status: 200 }
      )
    );

    await expect(
      logClientSecurityEvent("access-token", {
        action: "ATTEMPT_PRINT",
        metadata: { route: "/tasks/task-1" },
      })
    ).resolves.toMatchObject({ action: "ATTEMPT_PRINT" });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/security/client-events");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer access-token");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ action: "ATTEMPT_PRINT", metadata: { route: "/tasks/task-1" } })
    );
    fetchMock.mockRestore();
  });

  it("sends the selected PII audio mask mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          task_id: "task-1",
          masked_audio_url: "/api/v1/media/audio/token",
          mask_mode: "beep",
          expires_in_seconds: 300,
          masked_intervals: [],
          accepted_intervals: [],
          alignment_intervals: [],
          words: [],
          generated_at: new Date().toISOString(),
        }),
        { status: 200 }
      )
    );

    await maskTaskPIIAudio("annotator-token", "task-1", false, "beep");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/tasks/task-1/mask-pii-audio");
    expect(url.searchParams.get("mask_mode")).toBe("beep");
    expect(url.searchParams.get("force")).toBeNull();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    fetchMock.mockRestore();
  });

  it("sends adjusted PII mask intervals when regenerating masked audio", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          task_id: "task-1",
          masked_audio_url: "/api/v1/media/audio/token",
          mask_mode: "silence",
          expires_in_seconds: 300,
          masked_intervals: [{ start_seconds: 0.1, end_seconds: 0.6, labels: ["PHONE"], text: "1234567890" }],
          accepted_intervals: [{ start_seconds: 0.1, end_seconds: 0.6, labels: ["PHONE"], text: "1234567890" }],
          alignment_intervals: [{ start_seconds: 0.08, end_seconds: 0.62, labels: ["PHONE"], text: "1234567890" }],
          words: [],
          generated_at: new Date().toISOString(),
        }),
        { status: 200 }
      )
    );

    await maskTaskPIIAudio("annotator-token", "task-1", false, "silence", [
      { start_seconds: 0.1, end_seconds: 0.6, labels: ["PHONE"], text: "1234567890" },
    ]);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        mask_intervals: [{ start_seconds: 0.1, end_seconds: 0.6, labels: ["PHONE"], text: "1234567890" }],
      })
    );
    fetchMock.mockRestore();
  });

  it("requests backend hybrid PII detection for the final transcript", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pii_annotations: [
            {
              id: "auto-account",
              label: "ACCOUNT_NUMBER",
              start: 8,
              end: 12,
              value: "4829",
              source: "regex",
              confidence: 0.9,
            },
          ],
        }),
        { status: 200 }
      )
    );

    await expect(detectTaskPII("annotator-token", "Account 4829", true)).resolves.toMatchObject({
      pii_annotations: [{ label: "ACCOUNT_NUMBER", value: "4829" }],
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/tasks/detect-pii");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ transcript: "Account 4829", include_ml: true }));
    fetchMock.mockRestore();
  });

  it("keeps all-model PII detection alive long enough for cold ML warmup", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        window.setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                pii_annotations: [
                  {
                    id: "ml-person",
                    label: "PERSON",
                    start: 0,
                    end: 5,
                    value: "Maria",
                    source: "gliner",
                    confidence: 0.91,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }, 150_000);
      });
    });

    const detection = detectTaskPII("annotator-token", "Maria lives near Madrid", true);
    await vi.advanceTimersByTimeAsync(150_000);

    await expect(detection).resolves.toMatchObject({
      pii_annotations: [{ label: "PERSON", value: "Maria" }],
    });
    fetchMock.mockRestore();
    vi.useRealTimers();
  });
});

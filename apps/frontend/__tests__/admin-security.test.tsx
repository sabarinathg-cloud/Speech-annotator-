import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminSecurityPage from "@/app/(dashboard)/admin/security/page";

const { authState, fetchSecurityAuditEvents } = vi.hoisted(() => ({
  authState: {
    user: {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    },
  },
  fetchSecurityAuditEvents: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "admin-token",
    user: authState.user,
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
  fetchSecurityAuditEvents: (...args: unknown[]) => fetchSecurityAuditEvents(...args),
}));

describe("AdminSecurityPage", () => {
  beforeEach(() => {
    authState.user = {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    };
    fetchSecurityAuditEvents.mockResolvedValue({
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
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists sensitive actions for admins", async () => {
    render(<AdminSecurityPage />);

    expect(await screen.findByText("Security Audit")).toBeInTheDocument();
    expect(screen.getAllByText("EXPORT_TASKS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("high").length).toBeGreaterThan(0);
    expect(screen.getByText("admin@test.com")).toBeInTheDocument();
    expect(fetchSecurityAuditEvents).toHaveBeenCalledWith(
      "admin-token",
      expect.objectContaining({ page: 1, pageSize: 25 })
    );
  });

  it("filters events by action and risk level", async () => {
    render(<AdminSecurityPage />);
    await screen.findByText("Security Audit");

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "STREAM_AUDIO" } });
    fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "high" } });

    await waitFor(() =>
      expect(fetchSecurityAuditEvents).toHaveBeenLastCalledWith(
        "admin-token",
        expect.objectContaining({ action: "STREAM_AUDIO", riskLevel: "high" })
      )
    );
  });

  it("blocks non-admin users from viewing security events", () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    };

    render(<AdminSecurityPage />);

    expect(screen.getByText("Admin role is required to view security events.")).toBeInTheDocument();
    expect(fetchSecurityAuditEvents).not.toHaveBeenCalled();
  });
});

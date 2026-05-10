import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "@/app/(dashboard)/layout";

const { replace, acknowledgeConfidentiality, authState, pathnameState } = vi.hoisted(() => ({
  replace: vi.fn(),
  acknowledgeConfidentiality: vi.fn(),
  authState: {
    user: {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
      confidentiality_acknowledged_for_session: true,
    },
    accessToken: "test-token",
    isLoading: false,
  },
  pathnameState: {
    current: "/tasks",
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.current,
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: authState.user,
    accessToken: authState.accessToken,
    isLoading: authState.isLoading,
    logout: vi.fn(),
    acknowledgeConfidentiality,
  }),
}));

describe("DashboardLayout role navigation", () => {
  beforeEach(() => {
    replace.mockReset();
    acknowledgeConfidentiality.mockReset();
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
      confidentiality_acknowledged_for_session: true,
    };
    authState.accessToken = "test-token";
    authState.isLoading = false;
    pathnameState.current = "/tasks";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows only task navigation for annotators", () => {
    render(
      <DashboardLayout>
        <div>Assigned work</div>
      </DashboardLayout>
    );

    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Help" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open help and onboarding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin Upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Metrics" })).not.toBeInTheDocument();
    const watermark = screen.getByLabelText("Confidential workspace watermark");
    expect(watermark).toHaveTextContent("Confidential workspace");
    expect(watermark).toHaveTextContent("annotator@test.com");
  });

  it("redirects annotators away from admin routes", async () => {
    pathnameState.current = "/admin/metrics";

    render(
      <DashboardLayout>
        <div>Admin metrics</div>
      </DashboardLayout>
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/tasks"));
  });

  it("shows the security audit area for admins", () => {
    authState.user = {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
      confidentiality_acknowledged_for_session: true,
    };

    render(
      <DashboardLayout>
        <div>Admin work</div>
      </DashboardLayout>
    );

    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("href", "/admin/security");
  });

  it("blocks the dashboard behind a confidentiality acknowledgement until accepted", async () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: null,
      confidentiality_acknowledged_version: null,
      confidentiality_acknowledged_for_session: false,
    };
    acknowledgeConfidentiality.mockResolvedValueOnce(undefined);

    render(
      <DashboardLayout>
        <div>Assigned work</div>
      </DashboardLayout>
    );

    expect(screen.queryByText("Assigned work")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Confidentiality acknowledgement" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept and continue" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));

    await waitFor(() => expect(acknowledgeConfidentiality).toHaveBeenCalled());
  });

  it("treats older stored sessions without an acknowledgement field as unacknowledged", () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    } as typeof authState.user;

    render(
      <DashboardLayout>
        <div>Assigned work</div>
      </DashboardLayout>
    );

    expect(screen.queryByText("Assigned work")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Confidentiality acknowledgement" })).toBeInTheDocument();
  });
});

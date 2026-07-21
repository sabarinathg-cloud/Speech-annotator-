import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "@/app/(dashboard)/layout";

const { replace, acknowledgeConfidentiality, setActiveOrganizationId, authState, pathnameState } = vi.hoisted(() => ({
  replace: vi.fn(),
  acknowledgeConfidentiality: vi.fn(),
  setActiveOrganizationId: vi.fn(),
  authState: {
    user: {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString() as string | null,
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1" as string | null,
      confidentiality_acknowledged_for_session: true,
    },
    accessToken: "test-token",
    isLoading: false,
    activeOrganization: null as null | {
      id: string;
      name: string;
      slug: string;
      is_active: boolean;
      settings: {
        metadata_enabled: boolean;
        pii_enabled: boolean;
        transcript_redaction_enabled: boolean;
        audio_masking_enabled: boolean;
        hiring_enabled: boolean;
        instructions: string | null;
      };
    },
    activeOrganizationId: null as string | null,
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
    activeOrganization: authState.activeOrganization,
    activeOrganizationId: authState.activeOrganizationId,
    setActiveOrganizationId,
    logout: vi.fn(),
    acknowledgeConfidentiality,
  }),
}));

describe("DashboardLayout role navigation", () => {
  beforeEach(() => {
    replace.mockReset();
    acknowledgeConfidentiality.mockReset();
    setActiveOrganizationId.mockReset();
    window.localStorage.clear();
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
    authState.activeOrganization = null;
    authState.activeOrganizationId = null;
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

  it("shows organization instructions to annotators and keeps them reopenable", async () => {
    authState.activeOrganizationId = "org-1";
    authState.activeOrganization = {
      id: "org-1",
      name: "Clinical QA",
      slug: "clinical-qa",
      is_active: true,
      settings: {
        metadata_enabled: false,
        pii_enabled: false,
        transcript_redaction_enabled: false,
        audio_masking_enabled: false,
        hiring_enabled: false,
        instructions: "Listen fully before saving.\nUse punctuation when clear.",
      },
    };

    render(
      <DashboardLayout>
        <div>Assigned work</div>
      </DashboardLayout>
    );

    expect(await screen.findByRole("dialog", { name: "Organization instructions" })).toBeInTheDocument();
    expect(screen.getByText(/Listen fully before saving/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Organization instructions" })).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
    expect(screen.getByRole("dialog", { name: "Organization instructions" })).toBeInTheDocument();
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

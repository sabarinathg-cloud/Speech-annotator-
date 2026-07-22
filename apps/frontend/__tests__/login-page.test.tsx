import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "@/app/(auth)/login/page";

const { replace, loginRequest, authState } = vi.hoisted(() => ({
  replace: vi.fn(),
  loginRequest: vi.fn(),
  authState: {
    accessToken: null as string | null,
    isLoading: false,
    user: null as null | {
      id: string;
      email: string;
      full_name: string;
      role: "ADMIN" | "ANNOTATOR" | "REVIEWER" | "CANDIDATE";
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    login: loginRequest,
    accessToken: authState.accessToken,
    isLoading: authState.isLoading,
    user: authState.user,
  }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/login");
    authState.accessToken = null;
    authState.isLoading = false;
    authState.user = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a password changed success banner from the query string", async () => {
    window.history.pushState({}, "", "/login?passwordChanged=1");

    render(<LoginPage />);

    expect(await screen.findByText("Password changed. Sign in with your new password.")).toBeInTheDocument();
  });
});

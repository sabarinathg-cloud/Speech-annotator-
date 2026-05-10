import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, SESSION_IDLE_TIMEOUT_MS, useAuth } from "@/components/auth-provider";
import { readSession, writeSession } from "@/lib/session";

const DEVICE_SESSION_CHECK_INTERVAL_MS = 10 * 1000;

const { loginRequest, acknowledgeConfidentialityRequest, fetchCurrentUserRequest } = vi.hoisted(() => ({
  loginRequest: vi.fn(),
  acknowledgeConfidentialityRequest: vi.fn(),
  fetchCurrentUserRequest: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  login: (...args: unknown[]) => loginRequest(...args),
  acknowledgeConfidentiality: (...args: unknown[]) => acknowledgeConfidentialityRequest(...args),
  fetchCurrentUser: (...args: unknown[]) => fetchCurrentUserRequest(...args),
}));

function AuthProbe() {
  const { accessToken, user, acknowledgeConfidentiality } = useAuth();
  return (
    <div>
      <p>{accessToken ?? "no-token"}</p>
      <p>{user?.confidentiality_acknowledged_at ?? "not-acknowledged"}</p>
      <button type="button" onClick={() => void acknowledgeConfidentiality()}>
        Accept
      </button>
    </div>
  );
}

describe("AuthProvider security controls", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("clears the session after the protected workspace is idle", async () => {
    writeSession("access-token", "refresh-token", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    });
    vi.useFakeTimers();

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("access-token")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
    });
    expect(readSession().accessToken).toBe("access-token");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(readSession().accessToken).toBeNull();
    expect(screen.getByText("no-token")).toBeInTheDocument();
  });

  it("resets the idle timer when the user is active", async () => {
    writeSession("access-token", "refresh-token", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    });
    vi.useFakeTimers();

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("access-token")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
      window.dispatchEvent(new Event("mousemove"));
      vi.advanceTimersByTime(1000);
    });
    expect(readSession().accessToken).toBe("access-token");

    await act(async () => {
      vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS);
    });
    expect(readSession().accessToken).toBeNull();
  });

  it("persists the confidentiality acknowledgement in the session", async () => {
    writeSession("access-token", "refresh-token", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: null,
      confidentiality_acknowledged_version: null,
    });
    const acknowledgedAt = new Date().toISOString();
    acknowledgeConfidentialityRequest.mockResolvedValueOnce({
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
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(await screen.findByText("not-acknowledged")).toBeInTheDocument();
    await act(async () => {
      screen.getByRole("button", { name: "Accept" }).click();
    });

    expect(acknowledgeConfidentialityRequest).toHaveBeenCalledWith("access-token");
    expect(readSession().user?.confidentiality_acknowledged_at).toBe(acknowledgedAt);
    expect(await screen.findByText(acknowledgedAt)).toBeInTheDocument();
  });

  it("automatically clears the session when another device replaces it", async () => {
    writeSession("access-token", "refresh-token", {
      id: "user-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
      confidentiality_acknowledged_at: new Date().toISOString(),
      confidentiality_acknowledged_version: "2026-05-sensitive-data-v1",
    });
    fetchCurrentUserRequest.mockRejectedValueOnce({ status: 401 });
    vi.useFakeTimers();

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("access-token")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(DEVICE_SESSION_CHECK_INTERVAL_MS);
    });

    expect(fetchCurrentUserRequest).toHaveBeenCalledWith("access-token");
    expect(readSession().accessToken).toBeNull();
    expect(screen.getByText("no-token")).toBeInTheDocument();
  });
});

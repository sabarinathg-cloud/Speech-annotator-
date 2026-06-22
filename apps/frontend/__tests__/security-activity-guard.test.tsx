import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityActivityGuard } from "@/components/security-activity-guard";

const { logClientSecurityEventRequest } = vi.hoisted(() => ({
  logClientSecurityEventRequest: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  logClientSecurityEvent: (...args: unknown[]) => logClientSecurityEventRequest(...args),
}));

describe("SecurityActivityGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.history.pushState({}, "", "/tasks/task-1");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("blocks print shortcuts, warns the user, and logs the attempt", async () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      fireEvent.keyDown(document, { key: "p", ctrlKey: true });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Printing is disabled");
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_PRINT",
      metadata: expect.objectContaining({ route: "/tasks/task-1", shortcut: "Ctrl+P" }),
    });
  });

  it("blocks devtools shortcuts and logs the attempt", async () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      fireEvent.keyDown(document, { key: "F12" });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Developer tools are not allowed");
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_DEVTOOLS",
      metadata: expect.objectContaining({ route: "/tasks/task-1", shortcut: "F12" }),
    });
  });

  it("darkens the workspace when a screenshot shortcut is detected", async () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      fireEvent.keyDown(document, { key: "PrintScreen" });
    });

    expect(screen.getByLabelText("Screen privacy shield")).toBeInTheDocument();
    expect(screen.getByText("Screen protected")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Screen capture attempts are not permitted");
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_SCREEN_CAPTURE",
      metadata: expect.objectContaining({ route: "/tasks/task-1", shortcut: "PrintScreen" }),
    });

    await act(async () => {
      vi.advanceTimersByTime(6500);
    });
    expect(screen.queryByLabelText("Screen privacy shield")).not.toBeInTheDocument();
  });

  it("detects common macOS screenshot shortcuts", () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      fireEvent.keyDown(document, { key: "4", metaKey: true, shiftKey: true });
    });

    expect(screen.getByLabelText("Screen privacy shield")).toBeInTheDocument();
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_SCREEN_CAPTURE",
      metadata: expect.objectContaining({ route: "/tasks/task-1", shortcut: "Cmd+Shift+4" }),
    });
  });

  it("darkens the workspace when the browser loses focus", () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(screen.getByLabelText("Screen privacy shield")).toBeInTheDocument();
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_SCREEN_CAPTURE",
      metadata: expect.objectContaining({ route: "/tasks/task-1", trigger: "window_blur" }),
    });
  });

  it("clears the focus privacy shield after the browser regains focus", async () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByLabelText("Screen privacy shield")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(900);
    });

    expect(screen.queryByLabelText("Screen privacy shield")).not.toBeInTheDocument();
  });

  it("blocks context menu and hides the warning after a short delay", async () => {
    render(<SecurityActivityGuard accessToken="token" />);

    act(() => {
      fireEvent.contextMenu(document);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Right click is disabled");
    expect(logClientSecurityEventRequest).toHaveBeenCalledWith("token", {
      action: "ATTEMPT_CONTEXT_MENU",
      metadata: expect.objectContaining({ route: "/tasks/task-1" }),
    });

    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not attach controls without an access token", () => {
    render(<SecurityActivityGuard accessToken={null} />);

    fireEvent.keyDown(document, { key: "PrintScreen" });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(logClientSecurityEventRequest).not.toHaveBeenCalled();
  });

  it("does not block workspace actions when disabled", () => {
    render(<SecurityActivityGuard accessToken="token" enabled={false} />);

    expect(fireEvent.contextMenu(document)).toBe(true);
    expect(fireEvent.copy(document)).toBe(true);
    fireEvent.keyDown(document, { key: "PrintScreen" });
    window.dispatchEvent(new Event("blur"));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Screen privacy shield")).not.toBeInTheDocument();
    expect(logClientSecurityEventRequest).not.toHaveBeenCalled();
  });
});

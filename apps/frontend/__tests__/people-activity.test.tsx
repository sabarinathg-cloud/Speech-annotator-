import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PeopleActivityPage from "@/app/(dashboard)/admin/people-activity/page";

const { exportPeopleActivity, fetchPeopleActivity, fetchUsers } = vi.hoisted(() => ({
  exportPeopleActivity: vi.fn(),
  fetchPeopleActivity: vi.fn(),
  fetchUsers: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "admin-token",
    user: {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
    },
  }),
}));

vi.mock("@/lib/api", () => ({
  exportPeopleActivity: (...args: unknown[]) => exportPeopleActivity(...args),
  fetchPeopleActivity: (...args: unknown[]) => fetchPeopleActivity(...args),
  fetchUsers: (...args: unknown[]) => fetchUsers(...args),
}));

describe("PeopleActivityPage", () => {
  const summary = {
    active_seconds: 10800,
    task_active_seconds: 9000,
    idle_seconds: 1800,
    total_tracked_seconds: 12600,
    completed_segments: 50,
    average_active_seconds_per_segment: 180,
    efficiency_segments_per_active_hour: 20,
    focus_rate: 0.8333,
    last_activity_at: "2026-08-11T11:30:00Z",
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-11T12:00:00Z"));
    fetchUsers.mockResolvedValue({
      items: [
        {
          id: "user-1",
          email: "annotator@test.com",
          full_name: "Annotator One",
          role: "ANNOTATOR",
          is_active: true,
        },
        {
          id: "user-2",
          email: "reviewer@test.com",
          full_name: "Reviewer Two",
          role: "REVIEWER",
          is_active: true,
        },
      ],
    });
    fetchPeopleActivity.mockResolvedValue({
      generated_at: "2026-08-11T12:00:00Z",
      date_from: "2026-08-05",
      date_to: "2026-08-11",
      overall: summary,
      daily: [{ date: "2026-08-11", ...summary }],
      items: [
        {
          user_id: "user-1",
          user_name: "Annotator One",
          user_email: "annotator@test.com",
          role: "ANNOTATOR",
          is_active: true,
          overall: summary,
          daily: [{ date: "2026-08-11", ...summary }],
          organizations: [
            {
              organization_id: "org-1",
              organization_name: "Iris",
              organization_slug: "iris",
              active_seconds: 7200,
              task_active_seconds: 6000,
              idle_seconds: 1200,
              total_tracked_seconds: 8400,
              completed_segments: 30,
              average_active_seconds_per_segment: 200,
              efficiency_segments_per_active_hour: 18,
              focus_rate: 0.8333,
              last_activity_at: "2026-08-11T11:30:00Z",
            },
            {
              organization_id: "org-2",
              organization_name: "Flora",
              organization_slug: "flora",
              active_seconds: 3600,
              task_active_seconds: 3000,
              idle_seconds: 600,
              total_tracked_seconds: 4200,
              completed_segments: 20,
              average_active_seconds_per_segment: 150,
              efficiency_segments_per_active_hour: 24,
              focus_rate: 0.8333,
              last_activity_at: "2026-08-10T15:00:00Z",
            },
          ],
        },
        {
          user_id: "user-2",
          user_name: "Reviewer Two",
          user_email: "reviewer@test.com",
          role: "REVIEWER",
          is_active: true,
          overall: {
            ...summary,
            active_seconds: 5400,
            task_active_seconds: 4800,
            idle_seconds: 600,
            total_tracked_seconds: 6000,
            completed_segments: 18,
            average_active_seconds_per_segment: 266.6667,
            efficiency_segments_per_active_hour: 12,
            focus_rate: 0.8889,
            last_activity_at: "2026-08-11T10:15:00Z",
          },
          daily: [{ date: "2026-08-11", ...summary }],
          organizations: [
            {
              organization_id: "org-2",
              organization_name: "Flora",
              organization_slug: "flora",
              active_seconds: 5400,
              task_active_seconds: 4800,
              idle_seconds: 600,
              total_tracked_seconds: 6000,
              completed_segments: 18,
              average_active_seconds_per_segment: 266.6667,
              efficiency_segments_per_active_hour: 12,
              focus_rate: 0.8889,
              last_activity_at: "2026-08-11T10:15:00Z",
            },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("shows a seven-day cross-organization report with expandable organization totals", async () => {
    render(<PeopleActivityPage />);

    expect(await screen.findByRole("heading", { name: "People Activity" })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchPeopleActivity).toHaveBeenCalledWith("admin-token", {
        userIds: [],
        dateFrom: "2026-08-05",
        dateTo: "2026-08-11",
      })
    );
    expect(fetchUsers).toHaveBeenCalledWith("admin-token", { scope: "all" });
    expect(screen.getAllByText("Annotator One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reviewer Two").length).toBeGreaterThan(0);
    expect(screen.getByText("4h 30m")).toBeInTheDocument();
    expect(screen.getByText("68")).toBeInTheDocument();
    expect(screen.getByText("20.00/hr")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show organization breakdown for Annotator One" }));
    expect(screen.getByText("Iris")).toBeInTheDocument();
    expect(screen.getByText("Flora")).toBeInTheDocument();
    expect(screen.getByText("1h 40m task time")).toBeInTheDocument();
  });

  it("applies multiple selected people and exports with the applied userIds array", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    exportPeopleActivity.mockResolvedValue({ blob: new Blob(["csv"]), filename: "people.csv" });

    render(<PeopleActivityPage />);
    await screen.findByRole("heading", { name: "People Activity" });
    await screen.findByRole("button", { name: "People: All people" });

    const initialLoadCount = fetchPeopleActivity.mock.calls.length;
    const peopleButton = screen.getByRole("button", { name: "People: All people" });
    expect(peopleButton).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(peopleButton);
    expect(screen.getByRole("dialog", { name: "People filter" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "People options" })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search people" });
    fireEvent.change(search, { target: { value: "two" } });
    expect(fetchPeopleActivity).toHaveBeenCalledTimes(initialLoadCount);

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Annotator One" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Reviewer Two" }));

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(fetchPeopleActivity).toHaveBeenLastCalledWith("admin-token", {
        userIds: ["user-1", "user-2"],
        dateFrom: "2026-08-05",
        dateTo: "2026-08-11",
      })
    );
    expect(screen.getByRole("button", { name: "People: 2 people selected" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() =>
      expect(exportPeopleActivity).toHaveBeenCalledWith("admin-token", {
        userIds: ["user-1", "user-2"],
        dateFrom: "2026-08-05",
        dateTo: "2026-08-11",
      })
    );

    clickSpy.mockRestore();
  });

  it("applies cleared people selections as all people", async () => {
    render(<PeopleActivityPage />);
    await screen.findByRole("button", { name: "People: All people" });

    fireEvent.click(screen.getByRole("button", { name: "People: All people" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Annotator One" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Reviewer Two" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(fetchPeopleActivity).toHaveBeenLastCalledWith("admin-token", {
        userIds: [],
        dateFrom: "2026-08-05",
        dateTo: "2026-08-11",
      })
    );
  });
});

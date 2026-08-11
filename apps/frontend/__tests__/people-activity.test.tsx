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
      ],
    });
    fetchPeopleActivity.mockResolvedValue({
      generated_at: "2026-08-11T12:00:00Z",
      date_from: "2026-08-05",
      date_to: "2026-08-11",
      items: [
        {
          user_id: "user-1",
          user_name: "Annotator One",
          user_email: "annotator@test.com",
          role: "ANNOTATOR",
          is_active: true,
          overall: {
            active_seconds: 10800,
            task_active_seconds: 9000,
            idle_seconds: 1800,
            total_tracked_seconds: 12600,
            completed_segments: 50,
            average_active_seconds_per_segment: 180,
            efficiency_segments_per_active_hour: 20,
            focus_rate: 0.8333,
            last_activity_at: "2026-08-11T11:30:00Z",
          },
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
        userId: null,
        dateFrom: "2026-08-05",
        dateTo: "2026-08-11",
      })
    );
    expect(fetchUsers).toHaveBeenCalledWith("admin-token", { scope: "all" });
    expect(screen.getAllByText("Annotator One")).toHaveLength(2);
    expect(screen.getAllByText("3h 0m")).toHaveLength(2);
    expect(screen.getAllByText("50")).toHaveLength(2);
    expect(screen.getByText("20.00/hr")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show organization breakdown for Annotator One" }));
    expect(screen.getByText("Iris")).toBeInTheDocument();
    expect(screen.getByText("Flora")).toBeInTheDocument();
    expect(screen.getByText("1h 40m task time")).toBeInTheDocument();
  });
});

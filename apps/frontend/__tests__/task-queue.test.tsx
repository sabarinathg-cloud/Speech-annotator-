import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TasksPage from "@/app/(dashboard)/tasks/page";

const {
  push,
  authState,
  bulkAssignTasks,
  bulkAutoBalanceTasks,
  bulkCallSplitTasks,
  bulkCreateTaskAssignmentCopies,
  bulkUpdateTaskDueDates,
  bulkUpdateTaskStatuses,
  createTaskAssignmentCopy,
  downloadTaskExport,
  fetchNextTask,
  fetchTasks,
  fetchUsers,
  patchTaskAssignee,
  patchTaskDueDate,
} = vi.hoisted(() => ({
  push: vi.fn(),
  authState: {
    activeOrganizationId: "org-1",
    user: {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
    },
  },
  bulkAssignTasks: vi.fn(),
  bulkAutoBalanceTasks: vi.fn(),
  bulkCallSplitTasks: vi.fn(),
  bulkCreateTaskAssignmentCopies: vi.fn(),
  bulkUpdateTaskDueDates: vi.fn(),
  bulkUpdateTaskStatuses: vi.fn(),
  createTaskAssignmentCopy: vi.fn(),
  downloadTaskExport: vi.fn(),
  fetchNextTask: vi.fn(),
  fetchTasks: vi.fn(),
  fetchUsers: vi.fn(),
  patchTaskAssignee: vi.fn(),
  patchTaskDueDate: vi.fn(),
}));

const task = {
  id: "task-1",
  external_id: "OUT-001",
  file_location: "local:///tmp/audio.mp3",
  status: "Not Started",
  assignee_id: null,
  assignee_name: null,
  assignee_email: null,
  last_tagger_id: null,
  last_tagger_name: null,
  last_tagger_email: null,
  updated_at: new Date().toISOString(),
  last_saved_at: new Date().toISOString(),
  language: "en",
  speaker_role: "caller",
  due_date: null,
  version: 4,
};

const secondTask = {
  ...task,
  id: "task-2",
  external_id: "OUT-002",
  file_location: "local:///tmp/audio-2.mp3",
  version: 8,
};

function adminUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "reviewer-1",
    email: "reviewer@test.com",
    full_name: "Reviewer",
    role: "REVIEWER",
    is_active: true,
    last_login_at: null,
    last_activity_at: null,
    assigned_task_count: 4,
    open_assigned_task_count: 2,
    completed_task_count: 1,
    approved_task_count: 1,
    assignment_load: "light",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "test-token",
    user: authState.user,
    activeOrganizationId: authState.activeOrganizationId,
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
  bulkAssignTasks: (...args: unknown[]) => bulkAssignTasks(...args),
  bulkAutoBalanceTasks: (...args: unknown[]) => bulkAutoBalanceTasks(...args),
  bulkCallSplitTasks: (...args: unknown[]) => bulkCallSplitTasks(...args),
  bulkCreateTaskAssignmentCopies: (...args: unknown[]) => bulkCreateTaskAssignmentCopies(...args),
  bulkUpdateTaskDueDates: (...args: unknown[]) => bulkUpdateTaskDueDates(...args),
  bulkUpdateTaskStatuses: (...args: unknown[]) => bulkUpdateTaskStatuses(...args),
  createTaskAssignmentCopy: (...args: unknown[]) => createTaskAssignmentCopy(...args),
  downloadTaskExport: (...args: unknown[]) => downloadTaskExport(...args),
  fetchNextTask: (...args: unknown[]) => fetchNextTask(...args),
  fetchTasks: (...args: unknown[]) => fetchTasks(...args),
  fetchUsers: (...args: unknown[]) => fetchUsers(...args),
  patchTaskAssignee: (...args: unknown[]) => patchTaskAssignee(...args),
  patchTaskDueDate: (...args: unknown[]) => patchTaskDueDate(...args),
}));

describe("TasksPage queue workflows", () => {
  beforeEach(() => {
    authState.activeOrganizationId = "org-1";
    authState.user = {
      id: "admin-1",
      email: "admin@test.com",
      full_name: "Admin",
      role: "ADMIN",
    };
    fetchTasks.mockResolvedValue({
      items: [task],
      page: 1,
      page_size: 25,
      total: 1,
      status_counts: { "Not Started": 1 },
    });
    fetchUsers.mockResolvedValue({
      items: [
        adminUser(),
      ],
    });
    fetchNextTask.mockResolvedValue({ task_id: "task-1" });
    patchTaskAssignee.mockResolvedValue({ task: { ...task, assignee_id: "reviewer-1", assignee_name: "Reviewer", version: 5 } });
    patchTaskDueDate.mockResolvedValue({ task: { ...task, due_date: "2026-05-15", version: 5 } });
    bulkAssignTasks.mockResolvedValue({
      updated: [{ task: { ...task, assignee_id: "reviewer-1", assignee_name: "Reviewer", version: 5 } }],
      errors: [],
    });
    bulkAutoBalanceTasks.mockResolvedValue({
      matched_count: 19690,
      updated_count: 19690,
      skipped_count: 0,
      assignee_count: 1,
    });
    bulkCallSplitTasks.mockResolvedValue({
      matched_count: 19690,
      matched_call_count: 9845,
      updated_count: 19690,
      skipped_count: 0,
      assignee_count: 1,
      calls_per_assignee: 100,
      call_id_column: "call_id",
      assignments: [
        {
          assignee_id: "reviewer-1",
          assignee_name: "Reviewer",
          assignee_email: "reviewer@test.com",
          call_count: 9845,
          task_count: 19690,
        },
      ],
    });
    createTaskAssignmentCopy.mockResolvedValue({
      task: {
        ...task,
        id: "task-copy-1",
        external_id: "OUT-001__copy-reviewer-test-com-a1b2c3d4",
        assignee_id: "reviewer-1",
        assignee_name: "Reviewer",
        assignee_email: "reviewer@test.com",
        version: 1,
      },
    });
    bulkCreateTaskAssignmentCopies.mockResolvedValue({
      created: [
        {
          task: {
            ...task,
            id: "task-copy-1",
            external_id: "OUT-001__copy-reviewer-test-com-a1b2c3d4",
            assignee_id: "reviewer-1",
            assignee_name: "Reviewer",
            assignee_email: "reviewer@test.com",
            version: 1,
          },
        },
      ],
      errors: [],
    });
    bulkUpdateTaskDueDates.mockResolvedValue({
      updated: [
        { task: { ...task, due_date: "2026-05-22", version: 5 } },
        { task: { ...secondTask, due_date: "2026-05-22", version: 9 } },
      ],
      errors: [],
    });
    bulkUpdateTaskStatuses.mockResolvedValue({
      updated: [
        { task: { ...task, status: "In Progress", version: 5 } },
        { task: { ...secondTask, status: "In Progress", version: 9 } },
      ],
      errors: [],
    });
    downloadTaskExport.mockResolvedValue({
      blob: new Blob(["task_id\n"], { type: "text/csv" }),
      filename: "outcomes_ai_annotations_export.csv",
    });
    vi.spyOn(window.URL, "createObjectURL").mockReturnValue("blob:task-export");
    vi.spyOn(window.URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses backend unassigned filtering instead of client-side page filtering", async () => {
    render(<TasksPage />);
    await screen.findByText("Annotation Queue");

    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "unassigned" } });

    await waitFor(() =>
      expect(fetchTasks).toHaveBeenLastCalledWith(
        "test-token",
        expect.objectContaining({ assigneeId: "unassigned" })
      )
    );
  });

  it("reloads queue data immediately when the active organization changes", async () => {
    fetchTasks
      .mockResolvedValueOnce({
        items: [task],
        page: 1,
        page_size: 25,
        total: 1,
        status_counts: { "Not Started": 1 },
      })
      .mockResolvedValueOnce({
        items: [{ ...secondTask, external_id: "ORG-B-001" }],
        page: 1,
        page_size: 25,
        total: 1,
        status_counts: { "Not Started": 1 },
      });

    const { rerender } = render(<TasksPage />);
    await screen.findByText("OUT-001");

    authState.activeOrganizationId = "org-2";
    rerender(<TasksPage />);

    expect(await screen.findByText("ORG-B-001")).toBeInTheDocument();
    expect(fetchTasks).toHaveBeenCalledTimes(2);
  });

  it("opens the next assigned task for annotators without claim controls", async () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    };
    render(<TasksPage />);
    await screen.findByText("Annotation Queue");

    expect(screen.queryByRole("button", { name: "Claim Next" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Guided Tour" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Next Assigned" }));

    await waitFor(() => expect(fetchNextTask).toHaveBeenCalledWith("test-token"));
    expect(push).toHaveBeenCalledWith("/tasks/task-1");
  });

  it("opens the next assigned task with the guided tour forced on for annotators", async () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    };
    render(<TasksPage />);
    await screen.findByText("Annotation Queue");

    fireEvent.click(screen.getByRole("button", { name: "Open Guided Tour" }));

    await waitFor(() => expect(fetchNextTask).toHaveBeenCalledWith("test-token"));
    expect(push).toHaveBeenCalledWith("/tasks/task-1?tour=1");
  });

  it("loads only the signed-in annotator assignment and hides admin assignment controls", async () => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    };
    fetchTasks.mockResolvedValue({
      items: [{ ...task, assignee_id: "annotator-1", assignee_name: "Annotator", assignee_email: "annotator@test.com" }],
      page: 1,
      page_size: 25,
      total: 1,
      status_counts: { "Not Started": 1 },
    });

    render(<TasksPage />);
    await screen.findByText("OUT-001");

    expect(fetchTasks).toHaveBeenLastCalledWith(
      "test-token",
      expect.objectContaining({ assigneeId: "annotator-1" })
    );
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();
    expect(screen.queryByText("Bulk Assignment")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("bulk assigns selected tasks with their current versions", async () => {
    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.click(screen.getByLabelText("Select task OUT-001"));
    fireEvent.change(screen.getByLabelText("Bulk assignee"), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(bulkAssignTasks).toHaveBeenCalledWith("test-token", [
        { task_id: "task-1", version: 4, assignee_id: "reviewer-1" },
      ])
    );
    expect(await screen.findByText(/1 assigned, 0 conflict/)).toBeInTheDocument();
  });

  it("creates assignment copies so the same audio can go to another annotator", async () => {
    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.change(screen.getByLabelText("Assignee for OUT-001"), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign copy" }));

    await waitFor(() =>
      expect(createTaskAssignmentCopy).toHaveBeenCalledWith("test-token", "task-1", {
        version: 4,
        assignee_id: "reviewer-1",
      })
    );
    expect(await screen.findByText(/Created a separate assignment/)).toBeInTheDocument();
    expect(screen.getByText("OUT-001__copy-reviewer-test-com-a1b2c3d4")).toBeInTheDocument();
  });

  it("bulk creates assignment copies for selected audio", async () => {
    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.click(screen.getByLabelText("Select task OUT-001"));
    fireEvent.change(screen.getByLabelText("Bulk assignee"), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create copies" }));

    await waitFor(() =>
      expect(bulkCreateTaskAssignmentCopies).toHaveBeenCalledWith("test-token", [
        { task_id: "task-1", version: 4, assignee_id: "reviewer-1" },
      ])
    );
    expect(await screen.findByText(/1 copies created, 0 conflict/)).toBeInTheDocument();
  });

  it("auto-balances selected tasks across active eligible users by workload", async () => {
    fetchTasks.mockResolvedValue({
      items: [task, secondTask],
      page: 1,
      page_size: 25,
      total: 2,
      status_counts: { "Not Started": 2 },
    });
    fetchUsers.mockResolvedValue({
      items: [
        adminUser({
          id: "annotator-1",
          email: "ann@test.com",
          full_name: "Ann Annotator",
          role: "ANNOTATOR",
          open_assigned_task_count: 0,
          assignment_load: "none",
        }),
        adminUser({
          id: "annotator-2",
          email: "ben@test.com",
          full_name: "Ben Annotator",
          role: "ANNOTATOR",
          open_assigned_task_count: 3,
          assignment_load: "light",
        }),
      ],
    });
    bulkAssignTasks.mockResolvedValue({
      updated: [
        { task: { ...task, assignee_id: "annotator-1", assignee_name: "Ann Annotator", version: 5 } },
        { task: { ...secondTask, assignee_id: "annotator-2", assignee_name: "Ben Annotator", version: 9 } },
      ],
      errors: [],
    });

    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.click(screen.getByRole("button", { name: "Select unassigned visible" }));
    fireEvent.change(screen.getByLabelText("Assignment user role"), { target: { value: "ANNOTATOR" } });

    expect(screen.getAllByText("Ann Annotator").length).toBeGreaterThan(0);
    expect(screen.getByText("0 open")).toBeInTheDocument();
    expect(screen.getAllByText("Ben Annotator").length).toBeGreaterThan(0);
    expect(screen.getByText("3 open")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Auto-balance by call" }));

    await waitFor(() =>
      expect(bulkAssignTasks).toHaveBeenCalledWith("test-token", [
        { task_id: "task-1", version: 4, assignee_id: "annotator-1" },
        { task_id: "task-2", version: 8, assignee_id: "annotator-2" },
      ])
    );
    expect(await screen.findByText(/2 assigned, 0 conflict/)).toBeInTheDocument();
  });

  it("auto-balances all tasks matching the current filters beyond the visible page", async () => {
    fetchTasks.mockResolvedValue({
      items: [task, secondTask],
      page: 1,
      page_size: 25,
      total: 19690,
      status_counts: { "Not Started": 19690 },
    });
    fetchUsers.mockResolvedValue({
      items: [
        adminUser({
          id: "annotator-1",
          email: "ann@test.com",
          full_name: "Ann Annotator",
          role: "ANNOTATOR",
          open_assigned_task_count: 0,
          assignment_load: "none",
        }),
        adminUser({
          id: "reviewer-1",
          email: "reviewer@test.com",
          full_name: "Reviewer",
          role: "REVIEWER",
          open_assigned_task_count: 0,
          assignment_load: "none",
        }),
      ],
    });
    bulkAutoBalanceTasks.mockResolvedValue({
      matched_count: 19690,
      updated_count: 19665,
      skipped_count: 25,
      assignee_count: 2,
    });

    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Not Started" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "unassigned" } });
    fireEvent.click(await screen.findByRole("button", { name: "Select all matching (19690)" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto-balance by call" }));

    await waitFor(() =>
      expect(bulkAutoBalanceTasks).toHaveBeenCalledWith("test-token", {
        filters: {
          status: "Not Started",
          search: null,
          assignee_id: "unassigned",
          job_id: null,
          language: null,
          date_from: null,
          date_to: null,
        },
        assignee_ids: ["annotator-1", "reviewer-1"],
        max_tasks: 50000,
      })
    );
    expect(bulkAssignTasks).not.toHaveBeenCalled();
    expect(await screen.findByText(/19665 tasks auto-balanced by call across 2 users/)).toBeInTheDocument();
  });

  it("assigns all matching tasks in call-wise batches", async () => {
    fetchTasks.mockResolvedValue({
      items: [task, secondTask],
      page: 1,
      page_size: 25,
      total: 19690,
      status_counts: { "Not Started": 19690 },
    });
    fetchUsers.mockResolvedValue({
      items: [
        adminUser({
          id: "annotator-1",
          email: "ann@test.com",
          full_name: "Ann Annotator",
          role: "ANNOTATOR",
          open_assigned_task_count: 0,
          assignment_load: "none",
        }),
        adminUser({
          id: "reviewer-1",
          email: "reviewer@test.com",
          full_name: "Reviewer",
          role: "REVIEWER",
          open_assigned_task_count: 0,
          assignment_load: "none",
        }),
      ],
    });
    bulkCallSplitTasks.mockResolvedValue({
      matched_count: 19690,
      matched_call_count: 9845,
      updated_count: 19665,
      skipped_count: 25,
      assignee_count: 2,
      calls_per_assignee: 100,
      call_id_column: "call_id",
      assignments: [
        {
          assignee_id: "annotator-1",
          assignee_name: "Ann Annotator",
          assignee_email: "ann@test.com",
          call_count: 5000,
          task_count: 10000,
        },
        {
          assignee_id: "reviewer-1",
          assignee_name: "Reviewer",
          assignee_email: "reviewer@test.com",
          call_count: 4845,
          task_count: 9690,
        },
      ],
    });

    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Not Started" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "unassigned" } });
    fireEvent.click(await screen.findByRole("button", { name: "Select all matching (19690)" }));
    fireEvent.change(screen.getByLabelText("Calls per assignee"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign call batches" }));

    await waitFor(() =>
      expect(bulkCallSplitTasks).toHaveBeenCalledWith("test-token", {
        filters: {
          status: "Not Started",
          search: null,
          assignee_id: "unassigned",
          job_id: null,
          language: null,
          date_from: null,
          date_to: null,
        },
        assignee_ids: ["annotator-1", "reviewer-1"],
        calls_per_assignee: 100,
        call_id_column: "call_id",
        max_tasks: 50000,
      })
    );
    expect(bulkAssignTasks).not.toHaveBeenCalled();
    expect(await screen.findByText(/19665 tasks assigned across 9845 calls/)).toBeInTheDocument();
  });

  it("shows queue progress and lets admins set optional due dates", async () => {
    fetchTasks.mockResolvedValue({
      items: [task],
      page: 1,
      page_size: 25,
      total: 4,
      status_counts: { "Not Started": 1, Completed: 1, Approved: 2 },
    });

    render(<TasksPage />);
    await screen.findByText("Annotation Queue");

    expect(screen.getByText("Queue Progress")).toBeInTheDocument();
    expect(screen.getByText("75% complete")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Due date for OUT-001"), { target: { value: "2026-05-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save due date for OUT-001" }));

    await waitFor(() =>
      expect(patchTaskDueDate).toHaveBeenCalledWith("test-token", "task-1", {
        version: 4,
        due_date: "2026-05-15",
      })
    );
  });

  it("lets admins bulk update due dates, move status, and export selected tasks", async () => {
    fetchTasks.mockResolvedValue({
      items: [task, secondTask],
      page: 1,
      page_size: 25,
      total: 2,
      status_counts: { "Not Started": 2 },
    });

    render(<TasksPage />);
    await screen.findByText("OUT-001");

    fireEvent.click(screen.getByLabelText("Select all visible tasks"));
    fireEvent.change(screen.getByLabelText("Bulk due date"), { target: { value: "2026-05-22" } });
    fireEvent.click(screen.getByRole("button", { name: "Update selected due dates" }));

    await waitFor(() =>
      expect(bulkUpdateTaskDueDates).toHaveBeenCalledWith("test-token", [
        { task_id: "task-1", version: 4, due_date: "2026-05-22" },
        { task_id: "task-2", version: 8, due_date: "2026-05-22" },
      ])
    );
    expect(await screen.findByText(/2 due dates updated, 0 conflict/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select all visible tasks"));
    fireEvent.change(screen.getByLabelText("Bulk status"), { target: { value: "In Progress" } });
    fireEvent.change(screen.getByLabelText("Bulk status note"), { target: { value: "Ready for today" } });
    fireEvent.click(screen.getByRole("button", { name: "Move selected status" }));

    await waitFor(() =>
      expect(bulkUpdateTaskStatuses).toHaveBeenCalledWith("test-token", {
        status: "In Progress",
        comment: "Ready for today",
        updates: [
          { task_id: "task-1", version: 5 },
          { task_id: "task-2", version: 9 },
        ],
      })
    );

    fireEvent.click(screen.getByLabelText("Select all visible tasks"));
    fireEvent.click(screen.getByRole("button", { name: "Export selected tasks" }));

    await waitFor(() =>
      expect(downloadTaskExport).toHaveBeenCalledWith("test-token", {
        format: "csv",
        taskIds: ["task-1", "task-2"],
      })
    );
    expect(await screen.findByText(/2 selected tasks exported/)).toBeInTheDocument();
  });
});

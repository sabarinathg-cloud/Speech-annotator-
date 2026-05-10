"use client";

import type { AdminUser, Role, TaskDetail, TaskListItem, TaskStatus } from "@outcomes/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import {
  APIError,
  bulkAssignTasks,
  bulkUpdateTaskDueDates,
  bulkUpdateTaskStatuses,
  downloadTaskExport,
  fetchNextTask,
  fetchTasks,
  fetchUsers,
  patchTaskAssignee,
  patchTaskDueDate
} from "@/lib/api";

const statusOptions: Array<TaskStatus | "All"> = [
  "All",
  "Not Started",
  "In Progress",
  "Completed",
  "Needs Review",
  "Reviewed",
  "Approved",
  "Rejected"
];

const progressStatuses: TaskStatus[] = ["Completed", "Needs Review", "Reviewed", "Approved"];
const assignmentRoleOptions: Array<Role | "all"> = ["all", "ANNOTATOR", "REVIEWER"];

function formatDueDateLabel(value: string | null): string {
  if (!value) return "No due date";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function assignmentLoadClass(load: AdminUser["assignment_load"]) {
  if (load === "none") return "border-[#d9eadf] bg-[#edf8f0] text-[#236140]";
  if (load === "light") return "border-[#cfe0ff] bg-[#f0f6ff] text-[#2c579b]";
  if (load === "normal") return "border-[#f1dfb6] bg-[#fff7e6] text-[#8a5b1e]";
  return "border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]";
}

function nextAssignmentLoad(openCount: number): AdminUser["assignment_load"] {
  if (openCount === 0) return "none";
  if (openCount <= 5) return "light";
  if (openCount <= 15) return "normal";
  return "heavy";
}

export default function TasksPage() {
  const { accessToken, user } = useAuth();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "All">("All");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchTasks>> | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assigneeDraftByTask, setAssigneeDraftByTask] = useState<Record<string, string>>({});
  const [dueDateDraftByTask, setDueDateDraftByTask] = useState<Record<string, string>>({});
  const [assignmentBusyTaskId, setAssignmentBusyTaskId] = useState<string | null>(null);
  const [dueDateBusyTaskId, setDueDateBusyTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [bulkDueDate, setBulkDueDate] = useState("");
  const [bulkStatus, setBulkStatus] = useState<TaskStatus>("In Progress");
  const [bulkStatusComment, setBulkStatusComment] = useState("");
  const [bulkExportFormat, setBulkExportFormat] = useState<"csv" | "xlsx">("csv");
  const [assignmentRoleFilter, setAssignmentRoleFilter] = useState<Role | "all">("all");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startTransition] = useTransition();
  const router = useRouter();
  const isAdmin = user?.role === "ADMIN";
  const isAnnotator = user?.role === "ANNOTATOR";
  const isReviewer = user?.role === "REVIEWER";
  const assignedQueueLabel = isAdmin ? "Open Next Unfinished" : "Open Next Assigned";

  useEffect(() => {
    if (!accessToken || !isAdmin) {
      setUsers([]);
      return;
    }
    void (async () => {
      try {
        const response = await fetchUsers(accessToken);
        setUsers(response.items);
      } catch {
        setUsers([]);
      }
    })();
  }, [accessToken, isAdmin]);

  useEffect(() => {
    if (!accessToken || (!isAdmin && !user?.id)) return;
    startTransition(async () => {
      try {
        const effectiveAssigneeId = isAdmin
          ? assigneeFilter === "all"
            ? undefined
            : assigneeFilter
          : user?.id;
        const response = await fetchTasks(accessToken, {
          search: search || undefined,
          status: statusFilter === "All" ? undefined : statusFilter,
          assigneeId: effectiveAssigneeId,
          page,
          pageSize: 25
        });
        setData(response);
        setAssigneeDraftByTask((prev) => {
          const next = { ...prev };
          response.items.forEach((task) => {
            if (!Object.prototype.hasOwnProperty.call(next, task.id)) {
              next[task.id] = task.assignee_id ?? "";
            }
          });
          return next;
        });
        setDueDateDraftByTask((prev) => {
          const next = { ...prev };
          response.items.forEach((task) => {
            if (!Object.prototype.hasOwnProperty.call(next, task.id)) {
              next[task.id] = task.due_date ?? "";
            }
          });
          return next;
        });
        setSelectedTaskIds((prev) => prev.filter((taskId) => response.items.some((task) => task.id === taskId)));
        setError(null);
      } catch (err) {
        if (err instanceof APIError) {
          setError(err.message);
          return;
        }
        setError("Failed to load tasks");
      }
    });
  }, [accessToken, statusFilter, assigneeFilter, search, page, isAdmin, user?.id]);

  const visibleTasks = data?.items ?? [];
  const selectedVisibleTasks = useMemo(
    () =>
      selectedTaskIds
        .map((taskId) => visibleTasks.find((task) => task.id === taskId))
        .filter((task): task is TaskListItem => Boolean(task)),
    [selectedTaskIds, visibleTasks]
  );
  const assignableUsers = useMemo(
    () =>
      users
        .filter((account) => {
          if (!account.is_active || account.role === "ADMIN") return false;
          return assignmentRoleFilter === "all" || account.role === assignmentRoleFilter;
        })
        .sort(
          (a, b) =>
            a.open_assigned_task_count - b.open_assigned_task_count ||
            a.full_name.localeCompare(b.full_name)
        ),
    [assignmentRoleFilter, users]
  );
  const completedCount = data
    ? progressStatuses.reduce((sum, progressStatus) => sum + (data.status_counts[progressStatus] ?? 0), 0)
    : 0;
  const progressPercent = data && data.total > 0 ? Math.round((completedCount / data.total) * 100) : 0;

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.page_size));
  }, [data]);

  async function openNextTask() {
    if (!accessToken) return;
    try {
      const next = await fetchNextTask(accessToken);
      if (next.task_id) {
        router.push(`/tasks/${next.task_id}`);
      }
    } catch {
      setError("Failed to fetch next task");
    }
  }

  async function openGuidedTourTask() {
    if (!accessToken) return;
    try {
      const next = await fetchNextTask(accessToken);
      if (next.task_id) {
        router.push(`/tasks/${next.task_id}?tour=1`);
      }
    } catch {
      setError("Failed to open guided tour");
    }
  }

  async function assignTask(taskId: string, currentVersion: number) {
    if (!accessToken || !isAdmin || assignmentBusyTaskId) return;
    const selectedAssignee = (assigneeDraftByTask[taskId] ?? "").trim();
    setAssignmentBusyTaskId(taskId);
    try {
      const response = await patchTaskAssignee(accessToken, taskId, {
        version: currentVersion,
        assignee_id: selectedAssignee || null,
      });
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  assignee_id: response.task.assignee_id,
                  assignee_name: response.task.assignee_name,
                  assignee_email: response.task.assignee_email,
                  version: response.task.version,
                  updated_at: response.task.updated_at,
                  last_saved_at: response.task.last_saved_at,
                }
              : task
          ),
        };
      });
      setAssigneeDraftByTask((prev) => ({ ...prev, [taskId]: response.task.assignee_id ?? "" }));
      const previousTask = visibleTasks.find((task) => task.id === taskId);
      adjustUserAssignmentCounts([
        {
          previous_assignee_id: previousTask?.assignee_id ?? null,
          assignee_id: response.task.assignee_id,
          status: response.task.status,
        },
      ]);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to assign task");
    } finally {
      setAssignmentBusyTaskId(null);
    }
  }

  async function saveDueDate(taskId: string, currentVersion: number) {
    if (!accessToken || !isAdmin || dueDateBusyTaskId) return;
    const dueDate = (dueDateDraftByTask[taskId] ?? "").trim() || null;
    setDueDateBusyTaskId(taskId);
    try {
      const response = await patchTaskDueDate(accessToken, taskId, {
        version: currentVersion,
        due_date: dueDate,
      });
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  due_date: response.task.due_date,
                  version: response.task.version,
                  updated_at: response.task.updated_at,
                  last_saved_at: response.task.last_saved_at,
                }
              : task
          ),
        };
      });
      setDueDateDraftByTask((prev) => ({ ...prev, [taskId]: response.task.due_date ?? "" }));
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update due date");
    } finally {
      setDueDateBusyTaskId(null);
    }
  }

  async function applyBulkAssignment() {
    if (!accessToken || !isAdmin || bulkBusy || selectedTaskIds.length === 0) return;
    const assignments = selectedVisibleTasks
      .map((task) => ({
        task_id: task.id,
        version: task.version,
        assignee_id: bulkAssigneeId || null,
      }));
    await applyAssignmentBatch(assignments, "Bulk assignment failed");
  }

  async function applyAutoBalanceAssignment() {
    if (!accessToken || !isAdmin || bulkBusy || selectedVisibleTasks.length === 0 || assignableUsers.length === 0) return;
    const orderedUsers = [...assignableUsers];
    const assignments = selectedVisibleTasks.map((task, index) => {
      const assignee = orderedUsers[index % orderedUsers.length];
      return {
        task_id: task.id,
        version: task.version,
        assignee_id: assignee.id,
      };
    });
    await applyAssignmentBatch(assignments, "Auto-balance assignment failed");
  }

  async function applyAssignmentBatch(
    assignments: Array<{ task_id: string; version: number; assignee_id: string | null }>,
    fallbackMessage: string
  ) {
    if (!accessToken || !isAdmin || bulkBusy || assignments.length === 0) return;
    setBulkBusy(true);
    try {
      const response = await bulkAssignTasks(accessToken, assignments);
      const updatedById = new Map(response.updated.map((item) => [item.task.id, item.task]));
      const previousByTaskId = new Map(visibleTasks.map((task) => [task.id, task]));
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((task) => {
            const updated = updatedById.get(task.id);
            return updated
              ? {
                  ...task,
                  assignee_id: updated.assignee_id,
                  assignee_name: updated.assignee_name,
                  assignee_email: updated.assignee_email,
                  version: updated.version,
                  updated_at: updated.updated_at,
                  last_saved_at: updated.last_saved_at,
                }
              : task;
          }),
        };
      });
      setSelectedTaskIds((prev) => prev.filter((taskId) => !updatedById.has(taskId)));
      adjustUserAssignmentCounts(
        response.updated.map(({ task }) => ({
          previous_assignee_id: previousByTaskId.get(task.id)?.assignee_id ?? null,
          assignee_id: task.assignee_id,
          status: task.status,
        }))
      );
      setBulkResult(`${response.updated.length} assigned, ${response.errors.length} conflict/error${response.errors.length === 1 ? "" : "s"}.`);
      setError(response.errors[0]?.message ?? null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : fallbackMessage);
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyBulkDueDate() {
    if (!accessToken || !isAdmin || bulkBusy || selectedVisibleTasks.length === 0) return;
    const updates = selectedVisibleTasks.map((task) => ({
      task_id: task.id,
      version: task.version,
      due_date: bulkDueDate.trim() || null,
    }));
    setBulkBusy(true);
    try {
      const response = await bulkUpdateTaskDueDates(accessToken, updates);
      const updatedTasks = response.updated.map((item) => item.task);
      applyUpdatedTaskDetails(updatedTasks);
      setDueDateDraftByTask((prev) => {
        const next = { ...prev };
        updatedTasks.forEach((task) => {
          next[task.id] = task.due_date ?? "";
        });
        return next;
      });
      clearUpdatedSelection(updatedTasks);
      setBulkResult(`${response.updated.length} due dates updated, ${response.errors.length} conflict/error${response.errors.length === 1 ? "" : "s"}.`);
      setError(response.errors[0]?.message ?? null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Bulk due date update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyBulkStatus() {
    if (!accessToken || !isAdmin || bulkBusy || selectedVisibleTasks.length === 0) return;
    const updates = selectedVisibleTasks.map((task) => ({
      task_id: task.id,
      version: task.version,
    }));
    setBulkBusy(true);
    try {
      const response = await bulkUpdateTaskStatuses(accessToken, {
        status: bulkStatus,
        comment: bulkStatusComment.trim() || null,
        updates,
      });
      const updatedTasks = response.updated.map((item) => item.task);
      const previousByTaskId = new Map(visibleTasks.map((taskItem) => [taskItem.id, taskItem]));
      applyUpdatedTaskDetails(updatedTasks, previousByTaskId);
      clearUpdatedSelection(updatedTasks);
      setBulkResult(`${response.updated.length} statuses moved, ${response.errors.length} conflict/error${response.errors.length === 1 ? "" : "s"}.`);
      setError(response.errors[0]?.message ?? null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Bulk status update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportSelectedTasks() {
    if (!accessToken || !isAdmin || bulkBusy || selectedVisibleTasks.length === 0) return;
    const taskIds = selectedVisibleTasks.map((task) => task.id);
    setBulkBusy(true);
    try {
      const response = await downloadTaskExport(accessToken, { format: bulkExportFormat, taskIds });
      const objectUrl = window.URL.createObjectURL(response.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = response.filename;
      anchor.click();
      window.URL.revokeObjectURL(objectUrl);
      setBulkResult(`${taskIds.length} selected tasks exported.`);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Selected task export failed");
    } finally {
      setBulkBusy(false);
    }
  }

  function clearUpdatedSelection(updatedTasks: TaskDetail[]) {
    const updatedIds = new Set(updatedTasks.map((task) => task.id));
    setSelectedTaskIds((prev) => prev.filter((taskId) => !updatedIds.has(taskId)));
  }

  function applyUpdatedTaskDetails(
    updatedTasks: TaskDetail[],
    previousByTaskId: Map<string, TaskListItem> = new Map()
  ) {
    const updatedById = new Map(updatedTasks.map((task) => [task.id, task]));
    setData((prev) => {
      if (!prev) return prev;
      const nextStatusCounts = { ...prev.status_counts };
      updatedTasks.forEach((updated) => {
        const previous = previousByTaskId.get(updated.id) ?? prev.items.find((item) => item.id === updated.id);
        if (previous && previous.status !== updated.status) {
          nextStatusCounts[previous.status] = Math.max(0, (nextStatusCounts[previous.status] ?? 0) - 1);
          nextStatusCounts[updated.status] = (nextStatusCounts[updated.status] ?? 0) + 1;
        }
      });
      return {
        ...prev,
        status_counts: nextStatusCounts,
        items: prev.items.map((task) => {
          const updated = updatedById.get(task.id);
          return updated
            ? {
                ...task,
                status: updated.status,
                assignee_id: updated.assignee_id,
                assignee_name: updated.assignee_name,
                assignee_email: updated.assignee_email,
                last_tagger_id: updated.last_tagger_id,
                last_tagger_name: updated.last_tagger_name,
                last_tagger_email: updated.last_tagger_email,
                due_date: updated.due_date,
                language: updated.language,
                speaker_role: updated.speaker_role,
                version: updated.version,
                updated_at: updated.updated_at,
                last_saved_at: updated.last_saved_at,
              }
            : task;
        }),
      };
    });
  }

  function adjustUserAssignmentCounts(
    changes: Array<{ previous_assignee_id: string | null; assignee_id: string | null; status: TaskStatus }>
  ) {
    const assignedDeltas: Record<string, number> = {};
    const openDeltas: Record<string, number> = {};
    changes.forEach((change) => {
      if (change.previous_assignee_id === change.assignee_id) return;
      const isOpenTask = change.status !== "Approved";
      if (change.previous_assignee_id) {
        assignedDeltas[change.previous_assignee_id] = (assignedDeltas[change.previous_assignee_id] ?? 0) - 1;
        if (isOpenTask) {
          openDeltas[change.previous_assignee_id] = (openDeltas[change.previous_assignee_id] ?? 0) - 1;
        }
      }
      if (change.assignee_id) {
        assignedDeltas[change.assignee_id] = (assignedDeltas[change.assignee_id] ?? 0) + 1;
        if (isOpenTask) {
          openDeltas[change.assignee_id] = (openDeltas[change.assignee_id] ?? 0) + 1;
        }
      }
    });
    if (Object.keys(assignedDeltas).length === 0 && Object.keys(openDeltas).length === 0) return;
    setUsers((prev) =>
      prev.map((account) => {
        const assignedDelta = assignedDeltas[account.id] ?? 0;
        const openDelta = openDeltas[account.id] ?? 0;
        if (assignedDelta === 0 && openDelta === 0) return account;
        const assigned = Math.max(0, account.assigned_task_count + assignedDelta);
        const openAssigned = Math.max(0, account.open_assigned_task_count + openDelta);
        return {
          ...account,
          assigned_task_count: assigned,
          open_assigned_task_count: openAssigned,
          assignment_load: nextAssignmentLoad(openAssigned),
        };
      })
    );
  }

  function selectUnassignedVisibleTasks() {
    setSelectedTaskIds(visibleTasks.filter((task) => !task.assignee_id).map((task) => task.id));
  }

  return (
    <section className="animate-fade-in space-y-4">
      <div className="oa-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#797590]">Workspace</p>
            <h2 className="oa-title mt-1 text-xl font-semibold">Annotation Queue</h2>
            <p className="oa-subtext mt-1 text-sm">Search, filter, and open tasks for correction workflows.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isAnnotator ? (
              <button type="button" onClick={openGuidedTourTask} className="oa-btn-primary px-3.5 py-2 text-sm font-medium">
                Open Guided Tour
              </button>
            ) : null}
            <button type="button" onClick={openNextTask} className="oa-btn-secondary px-3.5 py-2 text-sm font-medium">
              {assignedQueueLabel}
            </button>
          </div>
        </div>

        <div className={`mt-4 grid grid-cols-1 gap-3 ${isAdmin ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Search</span>
            <input
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }}
              placeholder="Search by task ID or file location"
              className="oa-input"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                setPage(1);
                setStatusFilter(event.target.value as TaskStatus | "All");
              }}
              className="oa-select"
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          {isAdmin ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[#676280]">Assignee</span>
              <select
                value={assigneeFilter}
                onChange={(event) => {
                  setPage(1);
                  setAssigneeFilter(event.target.value);
                }}
                className="oa-select"
              >
                <option value="all">All</option>
                <option value="unassigned">Unassigned</option>
                {users.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.full_name} ({account.role})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="oa-card-soft flex flex-col justify-center px-3 py-2">
            <span className="text-xs font-medium text-[#676280]">Volume</span>
            <span className="mt-0.5 text-sm font-medium text-[#201d3f]">
              {data ? `Total ${data.total} tasks` : "Loading totals..."}
            </span>
          </div>
        </div>

        {isReviewer ? (
          <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Reviewer queue filters">
            {(["Needs Review", "Reviewed", "Approved", "Rejected"] as TaskStatus[]).map((reviewStatus) => (
              <button
                key={reviewStatus}
                type="button"
                onClick={() => {
                  setPage(1);
                  setStatusFilter(reviewStatus);
                }}
                className={statusFilter === reviewStatus ? "oa-btn-primary px-3 py-1.5 text-xs font-medium" : "oa-btn-secondary px-3 py-1.5 text-xs font-medium"}
              >
                {reviewStatus}
              </button>
            ))}
          </div>
        ) : null}

        {isAdmin ? (
          <div className="mt-4 rounded-xl border border-[#e6dcf2] bg-[#fbf8ff] px-3 py-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#625d7f]">
                  Smart Assignment
                </span>
                <span className="text-xs text-[#6f6a89]">{selectedTaskIds.length} selected</span>
                <button
                  type="button"
                  onClick={selectUnassignedVisibleTasks}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium"
                >
                  Select unassigned visible
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTaskIds([])}
                  disabled={selectedTaskIds.length === 0}
                  className="oa-btn-quiet px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Clear selection
                </button>
                {bulkResult ? <span className="text-xs text-[#5f5b77]">{bulkResult}</span> : null}
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Assign selected to</span>
                  <select
                    aria-label="Bulk assignee"
                    value={bulkAssigneeId}
                    onChange={(event) => setBulkAssigneeId(event.target.value)}
                    className="oa-select py-1.5 text-xs"
                  >
                    <option value="">Unassigned</option>
                    {assignableUsers.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.full_name} ({account.role}, {account.open_assigned_task_count} open)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Eligible role</span>
                  <select
                    aria-label="Assignment user role"
                    value={assignmentRoleFilter}
                    onChange={(event) => setAssignmentRoleFilter(event.target.value as Role | "all")}
                    className="oa-select py-1.5 text-xs"
                  >
                    {assignmentRoleOptions.map((role) => (
                      <option key={role} value={role}>
                        {role === "all" ? "Annotators and reviewers" : role}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={applyBulkAssignment}
                  disabled={bulkBusy || selectedTaskIds.length === 0}
                  className="oa-btn-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bulkBusy ? "Applying..." : "Apply"}
                </button>
                <button
                  type="button"
                  onClick={applyAutoBalanceAssignment}
                  disabled={bulkBusy || selectedTaskIds.length === 0 || assignableUsers.length === 0}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Auto-balance selected
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Bulk due date</span>
                  <input
                    type="date"
                    aria-label="Bulk due date"
                    value={bulkDueDate}
                    onChange={(event) => setBulkDueDate(event.target.value)}
                    className="oa-input py-1.5 text-xs"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Bulk status</span>
                  <select
                    aria-label="Bulk status"
                    value={bulkStatus}
                    onChange={(event) => setBulkStatus(event.target.value as TaskStatus)}
                    className="oa-select py-1.5 text-xs"
                  >
                    {statusOptions.filter((status): status is TaskStatus => status !== "All").map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Bulk status note</span>
                  <input
                    aria-label="Bulk status note"
                    value={bulkStatusComment}
                    onChange={(event) => setBulkStatusComment(event.target.value)}
                    placeholder="Optional audit note"
                    className="oa-input py-1.5 text-xs"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={applyBulkDueDate}
                    disabled={bulkBusy || selectedTaskIds.length === 0}
                    className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Update selected due dates
                  </button>
                  <button
                    type="button"
                    onClick={applyBulkStatus}
                    disabled={bulkBusy || selectedTaskIds.length === 0}
                    className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Move selected status
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[160px] flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Export format</span>
                  <select
                    aria-label="Bulk export format"
                    value={bulkExportFormat}
                    onChange={(event) => setBulkExportFormat(event.target.value as "csv" | "xlsx")}
                    className="oa-select py-1.5 text-xs"
                  >
                    <option value="csv">CSV</option>
                    <option value="xlsx">Excel</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={exportSelectedTasks}
                  disabled={bulkBusy || selectedTaskIds.length === 0}
                  className="oa-btn-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Export selected tasks
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                {assignableUsers.slice(0, 8).map((account) => (
                  <div key={account.id} className="rounded-lg border border-[#e7ddf3] bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#292441]">{account.full_name}</p>
                        <p className="text-xs text-[#6f6a89]">{account.role}</p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${assignmentLoadClass(account.assignment_load)}`}>
                        {account.assignment_load}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-[#5f5a76]">
                      <span>{account.open_assigned_task_count} open</span>
                      <span>{account.completed_task_count} completed</span>
                    </div>
                  </div>
                ))}
                {assignableUsers.length === 0 ? (
                  <div className="rounded-lg border border-[#f0c8c8] bg-white px-3 py-2 text-xs text-[#a13a3a]">
                    No active users match this assignment role.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {data ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-[#e6dcf2] bg-white px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#625d7f]">
                  Queue Progress
                </span>
                <span className="text-sm font-semibold text-[#241f43]">{progressPercent}% complete</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#ede9f7]">
                <div
                  className="h-full rounded-full bg-[#7c6cb0]"
                  style={{ width: `${progressPercent}%` }}
                  aria-label={`Queue progress ${progressPercent}% complete`}
                />
              </div>
              <p className="mt-1 text-xs text-[#6f6a89]">
                {completedCount} of {data.total} tasks are completed, review-ready, reviewed, or approved.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.status_counts).map(([status, count]) => (
                <span key={status} className="oa-chip">
                  {status}: {count}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">
            {error}
          </p>
        ) : null}
      </div>

      <div className="oa-card overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="border-b border-[#ece2f7] bg-[linear-gradient(180deg,#faf6ff_0%,#f8f2ff_100%)]">
              <tr>
                {isAdmin ? (
                  <th className="px-3 py-2.5 text-left">
                    <input
                      aria-label="Select all visible tasks"
                      type="checkbox"
                      checked={visibleTasks.length > 0 && selectedTaskIds.length === visibleTasks.length}
                      onChange={(event) => {
                        setSelectedTaskIds(event.target.checked ? visibleTasks.map((task) => task.id) : []);
                      }}
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Task ID
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Assignee
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Last Tagged By
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Language
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Role
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Due
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Updated
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task) => (
                <tr key={task.id} className="border-t border-[#eee5f7] text-[#2a2546] transition hover:bg-[#fbf8ff]">
                  {isAdmin ? (
                    <td className="px-3 py-2.5">
                      <input
                        aria-label={`Select task ${task.external_id}`}
                        type="checkbox"
                        checked={selectedTaskIds.includes(task.id)}
                        onChange={(event) => {
                          setSelectedTaskIds((prev) =>
                            event.target.checked ? [...prev, task.id] : prev.filter((id) => id !== task.id)
                          );
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 font-medium">{task.external_id}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{task.assignee_name || "Unassigned"}</div>
                    <div className="text-xs text-[#6f6a89]">{task.assignee_email || "-"}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{task.last_tagger_name || "-"}</div>
                    <div className="text-xs text-[#6f6a89]">{task.last_tagger_email || "-"}</div>
                  </td>
                  <td className="px-3 py-2.5">{task.language || "-"}</td>
                  <td className="px-3 py-2.5">{task.speaker_role || "-"}</td>
                  <td className="px-3 py-2.5">
                    {isAdmin ? (
                      <div className="flex min-w-[190px] items-center gap-1">
                        <input
                          type="date"
                          aria-label={`Due date for ${task.external_id}`}
                          value={dueDateDraftByTask[task.id] ?? task.due_date ?? ""}
                          onChange={(event) =>
                            setDueDateDraftByTask((prev) => ({ ...prev, [task.id]: event.target.value }))
                          }
                          className="oa-input py-1 text-xs"
                        />
                        <button
                          type="button"
                          aria-label={`Save due date for ${task.external_id}`}
                          onClick={() => void saveDueDate(task.id, task.version)}
                          disabled={dueDateBusyTaskId === task.id}
                          className="oa-btn-secondary px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {dueDateBusyTaskId === task.id ? "Saving..." : "Save"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-[#6f6a89]">{formatDueDateLabel(task.due_date)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[#6f6a89]">{new Date(task.updated_at).toLocaleString()}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col gap-2">
                      <Link href={`/tasks/${task.id}`} className="oa-btn-secondary px-2.5 py-1 text-center text-xs font-medium">
                        Open
                      </Link>
                      {isAdmin ? (
                        <div className="flex items-center gap-1">
                          <select
                            value={assigneeDraftByTask[task.id] ?? task.assignee_id ?? ""}
                            onChange={(event) =>
                              setAssigneeDraftByTask((prev) => ({ ...prev, [task.id]: event.target.value }))
                            }
                            className="oa-select min-w-[160px] py-1 text-xs"
                          >
                            <option value="">Unassigned</option>
                            {assignableUsers.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.full_name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => void assignTask(task.id, task.version)}
                            disabled={assignmentBusyTaskId === task.id}
                            className="oa-btn-primary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {assignmentBusyTaskId === task.id ? "Saving..." : "Assign"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {data && visibleTasks.length === 0 ? (
                <tr>
                  <td className="px-3 py-7 text-center text-sm text-[#7c7795]" colSpan={isAdmin ? 10 : 9}>
                    No tasks found for the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-[#6f6a89]">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            className="oa-btn-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!data || page >= totalPages}
            onClick={() => setPage((prev) => prev + 1)}
            className="oa-btn-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>

      {loading ? (
        <p className="rounded-lg border border-[#e6dcf2] bg-[#f8f4ff] px-3 py-2 text-sm text-[#6e6987]">Loading tasks...</p>
      ) : null}
    </section>
  );
}

"use client";

import type { AdminUser, BulkCallSplitStrategy, BulkTaskFilter, Role, TaskDetail, TaskListItem, TaskStatus } from "@outcomes/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import {
  APIError,
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

function formatDuration(seconds: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function nextAssignmentLoad(openCount: number): AdminUser["assignment_load"] {
  if (openCount === 0) return "none";
  if (openCount <= 5) return "light";
  if (openCount <= 15) return "normal";
  return "heavy";
}

function assignmentOptionLabel(account: AdminUser): string {
  return `${account.full_name} (${account.role}, ${account.open_assigned_task_count} open, ${formatDuration(account.open_assigned_duration_seconds)})`;
}

function taskCallKey(task: TaskListItem): string {
  const location = task.file_location || task.external_id;
  const normalized = location.replace(/^local:\/\//, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const filename = parts.at(-1) ?? "";
  if (!/(^|[_-])chunk[_-]?\d+\.(?:opus|wav)$/i.test(filename)) {
    return location;
  }
  const parent = parts.at(-2) ?? "";
  if (parent.toLowerCase().startsWith("channel") && parts.length >= 3) {
    return parts.slice(0, -2).join("/");
  }
  return parts.slice(0, -1).join("/") || location;
}

function workflowTypeLabel(task: TaskListItem): string {
  return task.workflow_type === "AUDIO_COMPARISON" ? "Audio comparison" : "Transcript";
}

function workflowTypeClass(task: TaskListItem): string {
  return task.workflow_type === "AUDIO_COMPARISON"
    ? "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]"
    : "border-[#e5dbf2] bg-[#fbf8ff] text-[#5f5a79]";
}

export default function TasksPage() {
  const { accessToken, user, activeOrganizationId } = useAuth();
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
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [bulkDueDate, setBulkDueDate] = useState("");
  const [bulkStatus, setBulkStatus] = useState<TaskStatus>("In Progress");
  const [bulkStatusComment, setBulkStatusComment] = useState("");
  const [bulkExportFormat, setBulkExportFormat] = useState<"csv" | "xlsx">("csv");
  const [assignmentRoleFilter, setAssignmentRoleFilter] = useState<Role | "all">("all");
  const [callSplitStrategy, setCallSplitStrategy] = useState<BulkCallSplitStrategy>("calls_per_assignee");
  const [callSplitSize, setCallSplitSize] = useState("100");
  const [callSplitColumn, setCallSplitColumn] = useState("call_id");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
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
  }, [accessToken, isAdmin, activeOrganizationId]);

  useEffect(() => {
    setAllMatchingSelected(false);
    setSelectedTaskIds([]);
  }, [search, statusFilter, assigneeFilter, activeOrganizationId]);

  useEffect(() => {
    setData(null);
    setAssigneeDraftByTask({});
    setDueDateDraftByTask({});
    setAllMatchingSelected(false);
    setSelectedTaskIds([]);
    setBulkResult(null);
    setError(null);
    setPage(1);
  }, [activeOrganizationId]);

  useEffect(() => {
    if (!accessToken || (!isAdmin && !user?.id)) return;
    let cancelled = false;
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
        if (cancelled) return;
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
        if (cancelled) return;
        if (err instanceof APIError) {
          setError(err.message);
          return;
        }
        setError("Failed to load tasks");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, statusFilter, assigneeFilter, search, page, isAdmin, user?.id, reloadKey, activeOrganizationId]);

  const visibleTasks = data?.items ?? [];
  const selectedVisibleTasks = useMemo(
    () =>
      selectedTaskIds
        .map((taskId) => visibleTasks.find((task) => task.id === taskId))
        .filter((task): task is TaskListItem => Boolean(task)),
    [selectedTaskIds, visibleTasks]
  );
  const bulkFilterPayload = useMemo<BulkTaskFilter>(
    () => ({
      status: statusFilter === "All" ? null : statusFilter,
      search: search.trim() || null,
      assignee_id: assigneeFilter === "all" ? null : assigneeFilter,
      job_id: null,
      language: null,
      date_from: null,
      date_to: null,
    }),
    [assigneeFilter, search, statusFilter]
  );
  const assignableUsers = useMemo(
    () =>
      users
        .filter((account) => {
          if (!account.is_active || account.role === "ADMIN" || account.role === "CANDIDATE") return false;
          return assignmentRoleFilter === "all" || account.role === assignmentRoleFilter;
        })
        .sort(
          (a, b) =>
            a.open_assigned_duration_seconds - b.open_assigned_duration_seconds ||
            a.open_assigned_task_count - b.open_assigned_task_count ||
            a.full_name.localeCompare(b.full_name)
        ),
    [assignmentRoleFilter, users]
  );
  const completedCount = data
    ? progressStatuses.reduce((sum, progressStatus) => sum + (data.status_counts[progressStatus] ?? 0), 0)
    : 0;
  const progressPercent = data && data.total > 0 ? Math.round((completedCount / data.total) * 100) : 0;
  const selectedTaskCount = allMatchingSelected ? data?.total ?? 0 : selectedTaskIds.length;
  const selectionLabel = allMatchingSelected
    ? `${selectedTaskCount} matching selected`
    : `${selectedTaskIds.length} visible selected`;
  const canSelectAllMatching = Boolean(data && data.total > 0 && data.total > visibleTasks.length);
  const onlyVisiblePageSelected = !allMatchingSelected && selectedTaskIds.length > 0 && selectedTaskIds.length === visibleTasks.length && canSelectAllMatching;

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
          duration_seconds: response.task.duration_seconds ?? previousTask?.duration_seconds ?? null,
        },
      ]);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to assign task");
    } finally {
      setAssignmentBusyTaskId(null);
    }
  }

  async function createAssignmentCopy(taskId: string, currentVersion: number) {
    if (!accessToken || !isAdmin || assignmentBusyTaskId) return;
    const selectedAssignee = (assigneeDraftByTask[taskId] ?? "").trim();
    if (!selectedAssignee) {
      setError("Choose an assignee before creating a copy");
      return;
    }
    setAssignmentBusyTaskId(taskId);
    try {
      const response = await createTaskAssignmentCopy(accessToken, taskId, {
        version: currentVersion,
        assignee_id: selectedAssignee,
      });
      appendCreatedTasksToQueue([response.task]);
      adjustUserAssignmentCounts([
        {
          previous_assignee_id: null,
          assignee_id: response.task.assignee_id,
          status: response.task.status,
          duration_seconds: response.task.duration_seconds,
        },
      ]);
      setBulkResult(`Created a separate assignment for ${response.task.assignee_name || "the selected user"}.`);
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to create assignment copy");
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
    if (allMatchingSelected) {
      setError("Bulk assign applies to visible selected rows. Use Auto-balance for all matching tasks.");
      return;
    }
    const assignments = selectedVisibleTasks
      .map((task) => ({
        task_id: task.id,
        version: task.version,
        assignee_id: bulkAssigneeId || null,
      }));
    await applyAssignmentBatch(assignments, "Bulk assignment failed");
  }

  async function applyBulkAssignmentCopies() {
    if (!accessToken || !isAdmin || bulkBusy || selectedTaskIds.length === 0) return;
    if (allMatchingSelected) {
      setError("Create copies applies to visible selected rows only.");
      return;
    }
    if (!bulkAssigneeId) {
      setError("Choose an assignee before creating copies");
      return;
    }
    const assignments = selectedVisibleTasks.map((task) => ({
      task_id: task.id,
      version: task.version,
      assignee_id: bulkAssigneeId,
    }));
    if (assignments.length === 0) return;
    setBulkBusy(true);
    try {
      const response = await bulkCreateTaskAssignmentCopies(accessToken, assignments);
      const createdTasks = response.created.map((item) => item.task);
      appendCreatedTasksToQueue(createdTasks);
      adjustUserAssignmentCounts(
        createdTasks.map((task) => ({
          previous_assignee_id: null,
          assignee_id: task.assignee_id,
          status: task.status,
          duration_seconds: task.duration_seconds,
        }))
      );
      setBulkResult(`${response.created.length} copies created, ${response.errors.length} conflict/error${response.errors.length === 1 ? "" : "s"}.`);
      setError(response.errors[0]?.message ?? null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Bulk copy assignment failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyAutoBalanceAssignment() {
    if (!accessToken || !isAdmin || bulkBusy || selectedTaskCount === 0 || assignableUsers.length === 0) return;
    if (allMatchingSelected) {
      setBulkBusy(true);
      try {
        const response = await bulkAutoBalanceTasks(accessToken, {
          filters: bulkFilterPayload,
          assignee_ids: assignableUsers.map((account) => account.id),
          max_tasks: 50000,
        });
        const protectedSummary =
          response.protected_task_count > 0
            ? ` ${response.protected_task_count} tasks in ${response.protected_call_count} worked calls were protected.`
            : "";
        setBulkResult(
          `${response.updated_count} tasks auto-balanced by call across ${response.assignee_count} users (${response.matched_count} matched, ${response.skipped_count} unchanged).${protectedSummary}`
        );
        setSelectedTaskIds([]);
        setAllMatchingSelected(false);
        setReloadKey((value) => value + 1);
        try {
          const usersResponse = await fetchUsers(accessToken);
          setUsers(usersResponse.items);
        } catch {
          // Keep the current user cards if the refresh fails; the queue refresh still shows task changes.
        }
        setError(null);
      } catch (err) {
        setError(err instanceof APIError ? err.message : "Auto-balance assignment failed");
      } finally {
        setBulkBusy(false);
      }
      return;
    }
    if (selectedVisibleTasks.length === 0) return;
    const orderedUsers = [...assignableUsers];
    const callGroups = new Map<string, TaskListItem[]>();
    selectedVisibleTasks.forEach((task) => {
      const callKey = taskCallKey(task);
      callGroups.set(callKey, [...(callGroups.get(callKey) ?? []), task]);
    });
    const assignments = Array.from(callGroups.values()).flatMap((tasksForCall, index) => {
      const assignee = orderedUsers[index % orderedUsers.length];
      return tasksForCall.map((task) => ({
        task_id: task.id,
        version: task.version,
        assignee_id: assignee.id,
      }));
    });
    await applyAssignmentBatch(assignments, "Auto-balance assignment failed");
  }

  async function applyCallSplitAssignment() {
    if (!accessToken || !isAdmin || bulkBusy || selectedTaskCount === 0 || assignableUsers.length === 0) return;
    if (!allMatchingSelected) {
      setError("Call-wise split applies to all matching tasks. Click Select all matching first.");
      return;
    }

    let parsedCallCount = Number.parseInt(callSplitSize, 10);
    if (callSplitStrategy === "calls_per_assignee") {
      if (!Number.isFinite(parsedCallCount) || parsedCallCount < 1 || parsedCallCount > 10000) {
        setError("Calls per assignee must be between 1 and 10000.");
        return;
      }
    } else {
      parsedCallCount = 100;
    }
    const column = callSplitColumn.trim() || "call_id";

    setBulkBusy(true);
    try {
      const response = await bulkCallSplitTasks(accessToken, {
        filters: bulkFilterPayload,
        assignee_ids: assignableUsers.map((account) => account.id),
        split_strategy: callSplitStrategy,
        calls_per_assignee: parsedCallCount,
        call_id_column: column,
        max_tasks: 50000,
      });
      const summary = response.assignments
        .filter((item) => item.call_count > 0)
        .map((item) =>
          callSplitStrategy === "duration_balance"
            ? `${item.assignee_name}: ${item.call_count} calls, ${formatDuration(item.duration_seconds)}`
            : `${item.assignee_name}: ${item.call_count} calls`
        )
        .join("; ");
      const assignedCallCount =
        response.assigned_call_count ?? response.assignments.reduce((count, item) => count + item.call_count, 0);
      const protectedSummary =
        response.protected_task_count > 0
          ? ` ${response.protected_task_count} tasks in ${response.protected_call_count} worked calls were protected.`
          : "";
      const durationSummary =
        callSplitStrategy === "duration_balance" && (response.missing_duration_task_count > 0 || response.estimated_duration_task_count > 0)
          ? ` ${response.estimated_duration_task_count} tasks had estimated or missing durations (${response.missing_duration_task_count} missing).`
          : "";
      const splitVerb = callSplitStrategy === "duration_balance" ? "balanced by duration across" : "assigned across";
      setBulkResult(
        `${response.updated_count} tasks ${splitVerb} ${assignedCallCount} calls (${response.matched_call_count} matched, ${response.skipped_count} unchanged).${protectedSummary}${durationSummary} ${summary}`
      );
      setSelectedTaskIds([]);
      setAllMatchingSelected(false);
      setReloadKey((value) => value + 1);
      try {
        const usersResponse = await fetchUsers(accessToken);
        setUsers(usersResponse.items);
      } catch {
        // Keep the current user cards if the refresh fails; the queue refresh still shows task changes.
      }
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Call-wise split assignment failed");
    } finally {
      setBulkBusy(false);
    }
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
          duration_seconds: task.duration_seconds,
        }))
      );
      setAllMatchingSelected(false);
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
    if (allMatchingSelected) {
      setError("Bulk due date applies to visible selected rows only.");
      return;
    }
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
    if (allMatchingSelected) {
      setError("Bulk status applies to visible selected rows only.");
      return;
    }
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
    if (allMatchingSelected) {
      setError("Export selected tasks applies to visible selected rows only.");
      return;
    }
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
    setAllMatchingSelected(false);
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
    changes: Array<{
      previous_assignee_id: string | null;
      assignee_id: string | null;
      status: TaskStatus;
      duration_seconds?: number | null;
    }>
  ) {
    const assignedDeltas: Record<string, number> = {};
    const openDeltas: Record<string, number> = {};
    const completedDeltas: Record<string, number> = {};
    const approvedDeltas: Record<string, number> = {};
    const assignedDurationDeltas: Record<string, number> = {};
    const openDurationDeltas: Record<string, number> = {};
    const completedDurationDeltas: Record<string, number> = {};
    const approvedDurationDeltas: Record<string, number> = {};
    changes.forEach((change) => {
      if (change.previous_assignee_id === change.assignee_id) return;
      const isOpenTask = change.status !== "Approved";
      const isCompletedTask = progressStatuses.includes(change.status);
      const isApprovedTask = change.status === "Approved";
      const duration = Math.max(0, change.duration_seconds ?? 0);
      if (change.previous_assignee_id) {
        assignedDeltas[change.previous_assignee_id] = (assignedDeltas[change.previous_assignee_id] ?? 0) - 1;
        assignedDurationDeltas[change.previous_assignee_id] =
          (assignedDurationDeltas[change.previous_assignee_id] ?? 0) - duration;
        if (isOpenTask) {
          openDeltas[change.previous_assignee_id] = (openDeltas[change.previous_assignee_id] ?? 0) - 1;
          openDurationDeltas[change.previous_assignee_id] =
            (openDurationDeltas[change.previous_assignee_id] ?? 0) - duration;
        }
        if (isCompletedTask) {
          completedDeltas[change.previous_assignee_id] = (completedDeltas[change.previous_assignee_id] ?? 0) - 1;
          completedDurationDeltas[change.previous_assignee_id] =
            (completedDurationDeltas[change.previous_assignee_id] ?? 0) - duration;
        }
        if (isApprovedTask) {
          approvedDeltas[change.previous_assignee_id] = (approvedDeltas[change.previous_assignee_id] ?? 0) - 1;
          approvedDurationDeltas[change.previous_assignee_id] =
            (approvedDurationDeltas[change.previous_assignee_id] ?? 0) - duration;
        }
      }
      if (change.assignee_id) {
        assignedDeltas[change.assignee_id] = (assignedDeltas[change.assignee_id] ?? 0) + 1;
        assignedDurationDeltas[change.assignee_id] = (assignedDurationDeltas[change.assignee_id] ?? 0) + duration;
        if (isOpenTask) {
          openDeltas[change.assignee_id] = (openDeltas[change.assignee_id] ?? 0) + 1;
          openDurationDeltas[change.assignee_id] = (openDurationDeltas[change.assignee_id] ?? 0) + duration;
        }
        if (isCompletedTask) {
          completedDeltas[change.assignee_id] = (completedDeltas[change.assignee_id] ?? 0) + 1;
          completedDurationDeltas[change.assignee_id] = (completedDurationDeltas[change.assignee_id] ?? 0) + duration;
        }
        if (isApprovedTask) {
          approvedDeltas[change.assignee_id] = (approvedDeltas[change.assignee_id] ?? 0) + 1;
          approvedDurationDeltas[change.assignee_id] = (approvedDurationDeltas[change.assignee_id] ?? 0) + duration;
        }
      }
    });
    const affectedUserIds = new Set([
      ...Object.keys(assignedDeltas),
      ...Object.keys(openDeltas),
      ...Object.keys(completedDeltas),
      ...Object.keys(approvedDeltas),
      ...Object.keys(assignedDurationDeltas),
      ...Object.keys(openDurationDeltas),
      ...Object.keys(completedDurationDeltas),
      ...Object.keys(approvedDurationDeltas),
    ]);
    if (affectedUserIds.size === 0) return;
    setUsers((prev) =>
      prev.map((account) => {
        const assignedDelta = assignedDeltas[account.id] ?? 0;
        const openDelta = openDeltas[account.id] ?? 0;
        const completedDelta = completedDeltas[account.id] ?? 0;
        const approvedDelta = approvedDeltas[account.id] ?? 0;
        const assignedDurationDelta = assignedDurationDeltas[account.id] ?? 0;
        const openDurationDelta = openDurationDeltas[account.id] ?? 0;
        const completedDurationDelta = completedDurationDeltas[account.id] ?? 0;
        const approvedDurationDelta = approvedDurationDeltas[account.id] ?? 0;
        if (
          assignedDelta === 0 &&
          openDelta === 0 &&
          completedDelta === 0 &&
          approvedDelta === 0 &&
          assignedDurationDelta === 0 &&
          openDurationDelta === 0 &&
          completedDurationDelta === 0 &&
          approvedDurationDelta === 0
        ) {
          return account;
        }
        const assigned = Math.max(0, account.assigned_task_count + assignedDelta);
        const openAssigned = Math.max(0, account.open_assigned_task_count + openDelta);
        const completed = Math.max(0, account.completed_task_count + completedDelta);
        const approved = Math.max(0, account.approved_task_count + approvedDelta);
        const assignedDuration = Math.max(0, account.assigned_duration_seconds + assignedDurationDelta);
        const openDuration = Math.max(0, account.open_assigned_duration_seconds + openDurationDelta);
        const completedDuration = Math.max(0, account.completed_duration_seconds + completedDurationDelta);
        const approvedDuration = Math.max(0, account.approved_duration_seconds + approvedDurationDelta);
        return {
          ...account,
          assigned_task_count: assigned,
          open_assigned_task_count: openAssigned,
          completed_task_count: completed,
          approved_task_count: approved,
          assigned_duration_seconds: assignedDuration,
          open_assigned_duration_seconds: openDuration,
          completed_duration_seconds: completedDuration,
          approved_duration_seconds: approvedDuration,
          assignment_load: nextAssignmentLoad(openAssigned),
        };
      })
    );
  }

  function appendCreatedTasksToQueue(createdTasks: TaskDetail[]) {
    if (createdTasks.length === 0) return;
    setData((prev) => {
      if (!prev) return prev;
      const createdItems = createdTasks.map((task) => task as TaskListItem);
      const createdIds = new Set(createdItems.map((task) => task.id));
      const statusCounts = { ...prev.status_counts };
      for (const task of createdItems) {
        statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
      }
      return {
        ...prev,
        items: [
          ...createdItems,
          ...prev.items.filter((task) => !createdIds.has(task.id)),
        ].slice(0, prev.page_size),
        total: prev.total + createdItems.length,
        status_counts: statusCounts,
      };
    });
    setAssigneeDraftByTask((prev) => {
      const next = { ...prev };
      for (const task of createdTasks) {
        next[task.id] = task.assignee_id ?? "";
      }
      return next;
    });
    setDueDateDraftByTask((prev) => {
      const next = { ...prev };
      for (const task of createdTasks) {
        next[task.id] = task.due_date ?? "";
      }
      return next;
    });
  }

  function selectUnassignedVisibleTasks() {
    setAllMatchingSelected(false);
    setSelectedTaskIds(visibleTasks.filter((task) => !task.assignee_id).map((task) => task.id));
  }

  function clearTaskSelection() {
    setAllMatchingSelected(false);
    setSelectedTaskIds([]);
  }

  function selectAllMatchingTasks() {
    if (!data || data.total === 0) return;
    setSelectedTaskIds([]);
    setAllMatchingSelected(true);
    setBulkResult(`All ${data.total} tasks matching the current filters are selected for auto-balance.`);
    setError(null);
  }

  return (
    <section className="animate-fade-in space-y-4">
      <div className="oa-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#797590]">Workspace</p>
            <h2 className="oa-title mt-1 text-xl font-semibold">Annotation Queue</h2>
            <p className="oa-subtext mt-1 text-sm">Search, filter, and open tasks for correction and comparison workflows.</p>
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
                <span className="text-xs text-[#6f6a89]">{selectionLabel}</span>
                <button
                  type="button"
                  onClick={selectUnassignedVisibleTasks}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium"
                >
                  Select unassigned visible
                </button>
                <button
                  type="button"
                  onClick={selectAllMatchingTasks}
                  disabled={!canSelectAllMatching || allMatchingSelected}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {data ? `Select all matching (${data.total})` : "Select all matching"}
                </button>
                <button
                  type="button"
                  onClick={clearTaskSelection}
                  disabled={selectedTaskCount === 0}
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
                        {assignmentOptionLabel(account)}
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
                  disabled={bulkBusy || selectedTaskIds.length === 0 || allMatchingSelected}
                  className="oa-btn-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bulkBusy ? "Applying..." : "Apply"}
                </button>
                <button
                  type="button"
                  onClick={applyBulkAssignmentCopies}
                  disabled={bulkBusy || selectedTaskIds.length === 0 || allMatchingSelected || !bulkAssigneeId}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Create copies
                </button>
                <button
                  type="button"
                  onClick={applyAutoBalanceAssignment}
                  disabled={bulkBusy || selectedTaskCount === 0 || assignableUsers.length === 0}
                  className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Auto-balance by call
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-lg border border-[#e6dcf2] bg-white px-3 py-3 lg:grid-cols-[minmax(250px,0.8fr)_minmax(180px,0.55fr)_minmax(180px,0.65fr)_1fr_auto] lg:items-end">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Call split mode</span>
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-[#ded4ef] bg-[#fbf8ff] p-1">
                    {[
                      { value: "calls_per_assignee", label: "By call count" },
                      { value: "duration_balance", label: "By duration" },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setCallSplitStrategy(option.value as BulkCallSplitStrategy)}
                        className={
                          callSplitStrategy === option.value
                            ? "rounded-md bg-[#221b4c] px-3 py-1.5 text-xs font-semibold text-white"
                            : "rounded-md px-3 py-1.5 text-xs font-semibold text-[#5f5b77] hover:bg-white"
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {callSplitStrategy === "calls_per_assignee" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[#676280]">Calls per assignee</span>
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      aria-label="Calls per assignee"
                      value={callSplitSize}
                      onChange={(event) => setCallSplitSize(event.target.value)}
                      className="oa-input py-1.5 text-xs"
                    />
                  </label>
                ) : (
                  <div className="rounded-lg border border-[#e5dbf2] bg-[#fbf8ff] px-3 py-2">
                    <p className="text-xs font-semibold text-[#403a60]">Equalize total duration</p>
                    <p className="mt-1 text-[11px] leading-snug text-[#6f6a89]">Longest calls are assigned first.</p>
                  </div>
                )}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#676280]">Call ID column</span>
                  <input
                    type="text"
                    aria-label="Call ID column"
                    value={callSplitColumn}
                    onChange={(event) => setCallSplitColumn(event.target.value)}
                    className="oa-input py-1.5 text-xs"
                    placeholder="call_id"
                  />
                </label>
                <p className="text-xs leading-relaxed text-[#6f6a89]">
                  {callSplitStrategy === "duration_balance"
                    ? "Uses all matching filtered tasks, keeps every call together, protects any call that already has work, and balances fresh calls by total audio duration."
                    : "Keeps chunks from the same call together and protects any call that already has work. Example: 100 sends the first 100 fresh calls to the first eligible user, next 100 to the next user, then repeats."}
                </p>
                <button
                  type="button"
                  onClick={applyCallSplitAssignment}
                  disabled={bulkBusy || !allMatchingSelected || selectedTaskCount === 0 || assignableUsers.length === 0}
                  className="oa-btn-primary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {callSplitStrategy === "duration_balance" ? "Balance by duration" : "Assign call batches"}
                </button>
              </div>
              {allMatchingSelected ? (
                <p className="rounded-lg border border-[#ded4ef] bg-white px-3 py-2 text-xs text-[#5f5b77]">
                  Auto-balance and call batches will update every task matching the current Search, Status, and Assignee filters. Auto-balance keeps all segments from the same call together. Use Assignee = Unassigned to update only unassigned tasks.
                  Calls with started or completed work are protected.
                </p>
              ) : null}
              {onlyVisiblePageSelected ? (
                <p className="rounded-lg border border-[#f1dfb6] bg-[#fffaf0] px-3 py-2 text-xs text-[#7a5a24]">
                  Only the visible page is selected. Use Select all matching to auto-balance every task in the current filter.
                </p>
              ) : null}

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
                    disabled={bulkBusy || selectedTaskIds.length === 0 || allMatchingSelected}
                    className="oa-btn-secondary px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Update selected due dates
                  </button>
                  <button
                    type="button"
                    onClick={applyBulkStatus}
                    disabled={bulkBusy || selectedTaskIds.length === 0 || allMatchingSelected}
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
                  disabled={bulkBusy || selectedTaskIds.length === 0 || allMatchingSelected}
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
                    <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-[#5f5a76]">
                      <div className="flex items-center justify-between gap-2">
                        <span>Open</span>
                        <span className="font-medium text-[#292441]">
                          {account.open_assigned_task_count} / {formatDuration(account.open_assigned_duration_seconds)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Done</span>
                        <span className="font-medium text-[#292441]">
                          {account.completed_task_count} / {formatDuration(account.completed_duration_seconds)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-[#eee6f7] pt-1">
                        <span>Total</span>
                        <span className="font-semibold text-[#292441]">
                          {account.assigned_task_count} / {formatDuration(account.assigned_duration_seconds)}
                        </span>
                      </div>
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
                      checked={visibleTasks.length > 0 && (allMatchingSelected || selectedTaskIds.length === visibleTasks.length)}
                      onChange={(event) => {
                        setAllMatchingSelected(false);
                        setSelectedTaskIds(event.target.checked ? visibleTasks.map((task) => task.id) : []);
                      }}
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Task ID
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#696482]">
                  Type
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
                        checked={allMatchingSelected || selectedTaskIds.includes(task.id)}
                        onChange={(event) => {
                          if (allMatchingSelected) {
                            setAllMatchingSelected(false);
                            setSelectedTaskIds(
                              visibleTasks
                                .filter((visibleTask) => visibleTask.id !== task.id)
                                .map((visibleTask) => visibleTask.id)
                            );
                          } else {
                            setSelectedTaskIds((prev) =>
                              event.target.checked ? [...prev, task.id] : prev.filter((id) => id !== task.id)
                            );
                          }
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 font-medium">{task.external_id}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${workflowTypeClass(task)}`}>
                      {workflowTypeLabel(task)}
                    </span>
                  </td>
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
                            aria-label={`Assignee for ${task.external_id}`}
                            value={assigneeDraftByTask[task.id] ?? task.assignee_id ?? ""}
                            onChange={(event) =>
                              setAssigneeDraftByTask((prev) => ({ ...prev, [task.id]: event.target.value }))
                            }
                            className="oa-select min-w-[160px] py-1 text-xs"
                          >
                            <option value="">Unassigned</option>
                            {assignableUsers.map((account) => (
                              <option key={account.id} value={account.id}>
                                {assignmentOptionLabel(account)}
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
                          <button
                            type="button"
                            onClick={() => void createAssignmentCopy(task.id, task.version)}
                            disabled={assignmentBusyTaskId === task.id || !(assigneeDraftByTask[task.id] ?? "").trim()}
                            className="oa-btn-secondary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Assign copy
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {data && visibleTasks.length === 0 ? (
                <tr>
                  <td className="px-3 py-7 text-center text-sm text-[#7c7795]" colSpan={isAdmin ? 11 : 10}>
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

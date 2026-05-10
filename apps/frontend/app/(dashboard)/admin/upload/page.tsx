"use client";

import type { AdminUser, ColumnMappingRequest, JobStatus, Role, TaskStatus, UserStatusFilter } from "@outcomes/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  createUser,
  downloadJobOutput,
  enqueueExportJob,
  enqueueImportJob,
  fetchJob,
  fetchUsers,
  previewUpload,
  resetUserPassword,
  uploadExcel,
  updateUser,
  validateUpload,
} from "@/lib/api";

type TranscriptMapDraft = {
  source_key: string;
  source_label: string;
  column_name: string;
};

const taskStatuses: Array<TaskStatus | "All"> = [
  "All",
  "Not Started",
  "In Progress",
  "Completed",
  "Needs Review",
  "Reviewed",
  "Approved",
  "Rejected",
];
const roleOptions: Role[] = ["ANNOTATOR", "REVIEWER", "ADMIN"];

function inferTranscriptMaps(columns: string[]): TranscriptMapDraft[] {
  return columns
    .filter((column) => /transcript/i.test(column) && !/final|corrected/i.test(column))
    .map((column) => {
      const sourceKey = column
        .replace(/_?transcript$/i, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      const sourceLabel = sourceKey
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      return {
        source_key: sourceKey || column,
        source_label: sourceLabel || column,
        column_name: column,
      };
    });
}

function formatGateLabel(gateKey: string): string {
  return gateKey
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function AdminUploadPage() {
  const { accessToken, user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [sampleRows, setSampleRows] = useState<Record<string, unknown>[]>([]);
  const [idColumn, setIdColumn] = useState("id");
  const [fileLocationColumn, setFileLocationColumn] = useState("file_location");
  const [finalTranscriptColumn, setFinalTranscriptColumn] = useState("");
  const [notesColumn, setNotesColumn] = useState("");
  const [speakerGenderColumn, setSpeakerGenderColumn] = useState("");
  const [speakerRoleColumn, setSpeakerRoleColumn] = useState("");
  const [languageColumn, setLanguageColumn] = useState("");
  const [channelColumn, setChannelColumn] = useState("");
  const [durationColumn, setDurationColumn] = useState("");
  const [transcriptMaps, setTranscriptMaps] = useState<TranscriptMapDraft[]>([]);
  const [validationResult, setValidationResult] = useState<Awaited<ReturnType<typeof validateUpload>> | null>(null);
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [importJob, setImportJob] = useState<JobStatus | null>(null);
  const [exportJob, setExportJob] = useState<JobStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx">("csv");
  const [exportStatus, setExportStatus] = useState<TaskStatus | "All">("All");
  const [exportAssigneeId, setExportAssigneeId] = useState("all");
  const [exportJobIdFilter, setExportJobIdFilter] = useState("");
  const [exportLanguage, setExportLanguage] = useState("");
  const [exportDateFrom, setExportDateFrom] = useState("");
  const [exportDateTo, setExportDateTo] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<Role | "all">("all");
  const [userStatusFilter, setUserStatusFilter] = useState<UserStatusFilter>("all");
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("ANNOTATOR");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [userActionMessage, setUserActionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canUpload = user?.role === "ADMIN";
  const mapping = useMemo<ColumnMappingRequest>(
    () => ({
      id_column: idColumn,
      file_location_column: fileLocationColumn,
      transcript_columns: transcriptMaps
        .filter((item) => item.source_key && item.column_name)
        .map((item) => ({
          source_key: item.source_key.trim(),
          source_label: item.source_label.trim(),
          column_name: item.column_name
        })),
      final_transcript_column: finalTranscriptColumn || null,
      notes_column: notesColumn || null,
      core_metadata_columns: {
        ...(speakerGenderColumn ? { speaker_gender: speakerGenderColumn } : {}),
        ...(speakerRoleColumn ? { speaker_role: speakerRoleColumn } : {}),
        ...(languageColumn ? { language: languageColumn } : {}),
        ...(channelColumn ? { channel: channelColumn } : {}),
        ...(durationColumn ? { duration_seconds: durationColumn } : {})
      }
    }),
    [
      channelColumn,
      durationColumn,
      fileLocationColumn,
      finalTranscriptColumn,
      idColumn,
      languageColumn,
      notesColumn,
      speakerGenderColumn,
      speakerRoleColumn,
      transcriptMaps
    ]
  );

  async function handleUpload() {
    if (!accessToken || !file) return;
    setBusy(true);
    setError(null);
    setValidationResult(null);
    setImportResult(null);
    try {
      const upload = await uploadExcel(accessToken, file);
      setUploadJobId(upload.upload_job_id);
      const preview = await previewUpload(accessToken, upload.upload_job_id);
      setColumns(preview.columns);
      setSampleRows(preview.sample_rows);
      setIdColumn(preview.columns.includes("id") ? "id" : preview.columns[0] || "");
      setFileLocationColumn(
        preview.columns.includes("file_location") ? "file_location" : preview.columns[1] || ""
      );
      setFinalTranscriptColumn("");
      setNotesColumn(preview.columns.includes("notes") ? "notes" : "");
      setSpeakerGenderColumn(preview.columns.includes("speaker_gender") ? "speaker_gender" : "");
      setSpeakerRoleColumn(preview.columns.includes("speaker_role") ? "speaker_role" : "");
      setLanguageColumn(preview.columns.includes("language") ? "language" : "");
      setChannelColumn(preview.columns.includes("channel") ? "channel" : "");
      setDurationColumn(
        preview.columns.includes("duration_seconds")
          ? "duration_seconds"
          : preview.columns.includes("duration")
            ? "duration"
            : ""
      );
      setTranscriptMaps(inferTranscriptMaps(preview.columns));
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleValidate() {
    if (!accessToken || !uploadJobId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await validateUpload(accessToken, uploadJobId, mapping);
      setValidationResult(result);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!accessToken || !uploadJobId) return;
    setBusy(true);
    setError(null);
    setImportJob(null);
    try {
      const queued = await enqueueImportJob(accessToken, uploadJobId, mapping);
      const completed = await pollJob(queued.job_id, setImportJob);
      setImportResult(completed.result);
      if (completed.status === "FAILED") {
        setError(completed.error_message ?? "Import job failed");
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setExportJob(null);
    try {
      const queued = await enqueueExportJob(accessToken, {
        format: exportFormat,
        status: exportStatus === "All" ? null : exportStatus,
        assignee_id: exportAssigneeId === "all" ? null : exportAssigneeId,
        job_id: exportJobIdFilter.trim() || null,
        language: exportLanguage.trim() || null,
        date_from: exportDateFrom || null,
        date_to: exportDateTo || null,
      });
      const completed = await pollJob(queued.job_id, setExportJob);
      if (completed.status === "FAILED") {
        setError(completed.error_message ?? "Export job failed");
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadExport() {
    if (!accessToken || !exportJob || exportJob.status !== "COMPLETED") return;
    try {
      const blob = await downloadJobOutput(accessToken, exportJob.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = String(exportJob.result?.filename ?? `annotations_export.${exportFormat}`);
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Download failed");
    }
  }

  async function pollJob(jobId: string, onUpdate: (job: JobStatus) => void): Promise<JobStatus> {
    if (!accessToken) {
      throw new Error("Missing access token");
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const job = await fetchJob(accessToken, jobId);
      onUpdate(job);
      if (job.status === "COMPLETED" || job.status === "FAILED") {
        return job;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("Job polling timed out");
  }

  const hasUpload = Boolean(uploadJobId);
  const hasValidation = Boolean(validationResult);
  const hasImport = Boolean(importResult || importJob?.status === "COMPLETED");
  const validationHasErrors = (validationResult?.errors.length ?? 0) > 0;
  const importBlockedByGates = hasValidation && !(validationResult?.import_allowed ?? true);
  const validationBadge = validationHasErrors
    ? {
        className: "border border-[#ffd4c8] bg-[#ffece6] text-[#8a422b]",
        label: "Issues Found",
      }
    : importBlockedByGates
      ? {
          className: "border border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]",
          label: "Gates Failed",
        }
      : {
          className: "border border-[#bfe7cf] bg-[#eafaf0] text-[#236140]",
          label: "Validation Passed",
        };
  const userFilterParams = useMemo(
    () => ({
      search: userSearch.trim() || null,
      role: userRoleFilter,
      status: userStatusFilter,
    }),
    [userRoleFilter, userSearch, userStatusFilter]
  );

  useEffect(() => {
    if (!accessToken || !canUpload) return;
    void (async () => {
      try {
        const response = await fetchUsers(accessToken, userFilterParams);
        setUsers(response.items);
      } catch {
        setUsers([]);
      }
    })();
  }, [accessToken, canUpload, userFilterParams]);

  useEffect(() => {
    if (!accessToken || !canUpload) return;
    void (async () => {
      try {
        const response = await fetchUsers(accessToken);
        setAllUsers(response.items);
      } catch {
        setAllUsers([]);
      }
    })();
  }, [accessToken, canUpload]);

  async function refreshUsers() {
    if (!accessToken) return;
    const [filteredResponse, allResponse] = await Promise.all([
      fetchUsers(accessToken, userFilterParams),
      fetchUsers(accessToken),
    ]);
    setUsers(filteredResponse.items);
    setAllUsers(allResponse.items);
  }

  async function handleCreateUser() {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setUserActionMessage(null);
    try {
      const created = await createUser(accessToken, {
        email: newUserEmail.trim(),
        full_name: newUserName.trim(),
        role: newUserRole,
        password: newUserPassword,
        is_active: true,
      });
      await refreshUsers();
      setUserActionMessage(`Created user ${created.full_name} (${created.role}).`);
      setNewUserName("");
      setNewUserEmail("");
      setNewUserPassword("");
      setNewUserRole("ANNOTATOR");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "User creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateUser(account: AdminUser, payload: { role?: Role; is_active?: boolean }) {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setUserActionMessage(null);
    try {
      const updated = await updateUser(accessToken, account.id, payload);
      await refreshUsers();
      setUserActionMessage(`Updated ${updated.full_name}.`);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "User update failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(account: AdminUser) {
    if (!accessToken) return;
    const password = resetPasswords[account.id]?.trim() ?? "";
    if (password.length < 8) return;
    setBusy(true);
    setError(null);
    setUserActionMessage(null);
    try {
      await resetUserPassword(accessToken, account.id, password);
      setResetPasswords((prev) => ({ ...prev, [account.id]: "" }));
      setUserActionMessage(`Reset password for ${account.full_name}.`);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Password reset failed");
    } finally {
      setBusy(false);
    }
  }

  function handleDownloadTemplate() {
    const headers = [
      "id",
      "file_location",
      "model_1_transcript",
      "model_2_transcript",
      "final_transcript",
      "notes",
      "speaker_gender",
      "speaker_role",
      "language",
      "channel",
      "duration_seconds",
    ];
    const example = [
      "CALL-0001",
      "local:///absolute/path/audio.wav",
      "first ASR transcript",
      "second ASR transcript",
      "",
      "review background noise",
      "female",
      "caller",
      "en",
      "mono",
      "12.4",
    ];
    const csv = `${headers.join(",")}\n${example.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "speech-annotator-upload-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!canUpload) {
    return (
      <section className="space-y-4">
        <div className="oa-card p-5">
          <h2 className="oa-title text-lg font-semibold">Upload Annotation Jobs</h2>
          <p className="oa-subtext mt-1 text-sm">
            Upload Excel, map columns, validate row-level errors, and import tasks.
          </p>
        </div>
        <div className="rounded-xl border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">
          Admin role is required to upload annotation jobs.
        </div>
      </section>
    );
  }

  return (
    <section className="animate-fade-in space-y-5">
      <div className="oa-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#787390]">Admin Operations</p>
            <h2 className="oa-title mt-1 text-xl font-semibold">Upload Annotation Jobs</h2>
            <p className="oa-subtext mt-1 text-sm">
              Upload Excel, map columns, validate row-level errors, and import tasks safely.
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <StepPill
            title="1. Upload"
            description="Select source spreadsheet and load preview."
            active={!hasUpload}
            complete={hasUpload}
          />
          <StepPill
            title="2. Map Columns"
            description="Assign ID, media, transcript, and metadata fields."
            active={hasUpload && !hasValidation}
            complete={hasValidation || hasImport}
          />
          <StepPill
            title="3. Validate"
            description="Catch row-level problems before import."
            active={hasValidation && !hasImport}
            complete={hasValidation}
          />
          <StepPill
            title="4. Import"
            description="Persist valid tasks to the annotation queue."
            active={hasValidation && !hasImport}
            complete={hasImport}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">{error}</div>
      ) : null}

      <div className="oa-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="oa-title text-base font-semibold">User Administration</h3>
            <p className="oa-subtext mt-1 text-sm">
              Create annotator/reviewer/admin accounts. Task assignment is available on the Tasks queue page.
            </p>
          </div>
          <span className="rounded-md border border-[#e3d8f3] bg-[#f7f1ff] px-2.5 py-1 text-xs text-[#5e597a]">
            {users.length} matching users
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-[#ece3f7] bg-[#fbf8ff] p-3 md:grid-cols-5">
          <label className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[#676280]">Search Users</span>
            <input
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Name or email"
              className="oa-input bg-white"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Role Filter</span>
            <select
              value={userRoleFilter}
              onChange={(event) => setUserRoleFilter(event.target.value as Role | "all")}
              className="oa-select bg-white"
            >
              <option value="all">All roles</option>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Status Filter</span>
            <select
              value={userStatusFilter}
              onChange={(event) => setUserStatusFilter(event.target.value as UserStatusFilter)}
              className="oa-select bg-white"
            >
              <option value="all">All users</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={refreshUsers}
              disabled={busy}
              className="oa-btn-secondary w-full px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">
          <label className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[#676280]">Full Name</span>
            <input
              value={newUserName}
              onChange={(event) => setNewUserName(event.target.value)}
              placeholder="Full name"
              className="oa-input"
            />
          </label>
          <label className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[#676280]">Work Email</span>
            <input
              value={newUserEmail}
              onChange={(event) => setNewUserEmail(event.target.value)}
              placeholder="Work email"
              className="oa-input"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Role</span>
            <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)} className="oa-select">
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 md:col-span-4">
            <span className="text-xs font-medium text-[#676280]">Temporary Password</span>
            <input
              value={newUserPassword}
              onChange={(event) => setNewUserPassword(event.target.value)}
              placeholder="Temporary password"
              type="password"
              className="oa-input"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleCreateUser}
              disabled={!newUserName.trim() || !newUserEmail.trim() || newUserPassword.length < 8 || busy}
              className="oa-btn-primary w-full px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              Create User
            </button>
          </div>
        </div>

        {userActionMessage ? (
          <p className="mt-3 rounded-md border border-[#bfe7cf] bg-[#eafaf0] px-3 py-2 text-sm text-[#236140]">
            {userActionMessage}
          </p>
        ) : null}

        <div className="mt-4 overflow-auto rounded-xl border border-[#e7ddf3]">
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="border-b border-[#ece2f7] bg-[#faf6ff]">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Name</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Email</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Role</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Assignment Load</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Task Counts</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Last Login</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Last Activity</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#6c6787]">Password</th>
              </tr>
            </thead>
            <tbody>
              {users.map((account) => {
                const isCurrentUser = account.id === user?.id;
                const resetPassword = resetPasswords[account.id] ?? "";
                return (
                  <tr key={account.id} className="border-t border-[#eee5f7] align-top">
                    <td className="px-3 py-2 font-medium text-[#282341]">{account.full_name}</td>
                    <td className="px-3 py-2 text-[#645f7d]">{account.email}</td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Role for ${account.email}`}
                        value={account.role}
                        onChange={(event) => handleUpdateUser(account, { role: event.target.value as Role })}
                        disabled={busy || isCurrentUser}
                        className="oa-select min-w-[130px] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {roleOptions.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <label className="inline-flex items-center gap-2 text-sm text-[#403c5d]">
                        <input
                          type="checkbox"
                          aria-label={`Active status for ${account.email}`}
                          checked={account.is_active}
                          onChange={(event) => handleUpdateUser(account, { is_active: event.target.checked })}
                          disabled={busy || isCurrentUser}
                          className="h-4 w-4 rounded border-[#cfc4df]"
                        />
                        {account.is_active ? "Active" : "Inactive"}
                      </label>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${assignmentLoadClass(account.assignment_load)}`}>
                        {account.assignment_load}
                      </span>
                      <p className="mt-1 text-xs text-[#6f6a88]">{account.open_assigned_task_count} open</p>
                    </td>
                    <td className="px-3 py-2 text-xs text-[#4a4564]">
                      <p>Assigned: {account.assigned_task_count}</p>
                      <p>Completed: {account.completed_task_count}</p>
                      <p>Approved: {account.approved_task_count}</p>
                    </td>
                    <td className="px-3 py-2 text-xs text-[#645f7d]">
                      {formatUserTimestamp(account.last_login_at, "No recorded login")}
                    </td>
                    <td className="px-3 py-2 text-xs text-[#645f7d]">
                      {formatUserTimestamp(account.last_activity_at, "No recorded activity")}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex min-w-[230px] gap-2">
                        <input
                          type="password"
                          aria-label={`Reset password for ${account.email}`}
                          value={resetPassword}
                          onChange={(event) =>
                            setResetPasswords((prev) => ({ ...prev, [account.id]: event.target.value }))
                          }
                          placeholder="New password"
                          className="oa-input"
                        />
                        <button
                          type="button"
                          onClick={() => handleResetPassword(account)}
                          disabled={busy || resetPassword.trim().length < 8}
                          className="oa-btn-secondary px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Reset
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-sm text-[#7c7795]" colSpan={9}>
                    No users match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="oa-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="oa-title text-base font-semibold">Export Annotations</h3>
            <p className="oa-subtext mt-1 text-sm">Create a filtered export in the background and download it when ready.</p>
          </div>
          {exportJob ? (
            <span className="rounded-md border border-[#e3d8f3] bg-[#f7f1ff] px-2.5 py-1 text-xs text-[#5e597a]">
              {exportJob.status}
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Format</span>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "csv" | "xlsx")} className="oa-select">
              <option value="csv">CSV</option>
              <option value="xlsx">XLSX</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Status</span>
            <select value={exportStatus} onChange={(event) => setExportStatus(event.target.value as TaskStatus | "All")} className="oa-select">
              {taskStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Assignee</span>
            <select value={exportAssigneeId} onChange={(event) => setExportAssigneeId(event.target.value)} className="oa-select">
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {allUsers.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Language</span>
            <input value={exportLanguage} onChange={(event) => setExportLanguage(event.target.value)} className="oa-input" placeholder="Any" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Upload Job</span>
            <input value={exportJobIdFilter} onChange={(event) => setExportJobIdFilter(event.target.value)} className="oa-input" placeholder="Any" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">From</span>
            <input type="date" value={exportDateFrom} onChange={(event) => setExportDateFrom(event.target.value)} className="oa-input" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">To</span>
            <input type="date" value={exportDateTo} onChange={(event) => setExportDateTo(event.target.value)} className="oa-input" />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={busy}
              className="oa-btn-primary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Working..." : "Start Export"}
            </button>
            <button
              type="button"
              onClick={handleDownloadExport}
              disabled={exportJob?.status !== "COMPLETED" || !exportJob.output_available}
              className="oa-btn-secondary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download
            </button>
          </div>
        </div>

        {exportJob?.error_message ? (
          <p className="mt-3 rounded-md border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">
            {exportJob.error_message}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="oa-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="oa-title text-base font-semibold">Step 1: Upload Source File</h3>
              <p className="oa-subtext mt-1 text-sm">Use `.xlsx` or `.xls` format exported from admin operations.</p>
            </div>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="oa-btn-secondary px-3 py-1.5 text-xs font-medium"
            >
              Download sample template
            </button>
          </div>

          <div className="oa-card-soft mt-4 border-dashed p-4">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="w-full text-sm text-[#5f5a79] file:mr-3 file:rounded-md file:border-0 file:bg-[#e9def6] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[#3b315e] hover:file:bg-[#dcccf0]"
            />
            <p className="mt-2 text-xs text-[#7a7494]">{file ? `Selected: ${file.name}` : "No file selected yet."}</p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleUpload}
              disabled={!file || busy}
              className="oa-btn-primary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Processing..." : "Upload & Preview"}
            </button>
            {uploadJobId ? (
              <span className="rounded-md border border-[#e3d8f3] bg-[#f7f1ff] px-2.5 py-1 text-xs text-[#5e597a]">
                Job: {uploadJobId}
              </span>
            ) : null}
          </div>
        </div>

        <div className="oa-card p-5">
          <h3 className="oa-title text-base font-semibold">Checklist</h3>
          <p className="oa-subtext mt-1 text-sm">For a clean first-pass import:</p>
          <ul className="mt-3 space-y-2 text-sm text-[#403c5d]">
            <li className="oa-card-soft px-3 py-2">Ensure one unique ID per row.</li>
            <li className="oa-card-soft px-3 py-2">
              Confirm `file_location` points to playable media.
            </li>
            <li className="oa-card-soft px-3 py-2">
              Map at least one transcript source before validation.
            </li>
          </ul>
        </div>
      </div>

      {uploadJobId ? (
        <div className="oa-card space-y-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="oa-title text-base font-semibold">Step 2: Column Mapping</h3>
            <span className="rounded-md border border-[#e3d8f3] bg-[#f7f1ff] px-2.5 py-1 text-xs text-[#605a7e]">
              {columns.length} detected columns
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="oa-card-soft p-4">
              <h4 className="text-sm font-semibold text-[#262240]">Required Fields</h4>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <ColumnSelect label="ID Column" value={idColumn} columns={columns} onChange={setIdColumn} />
                <ColumnSelect
                  label="File Location Column"
                  value={fileLocationColumn}
                  columns={columns}
                  onChange={setFileLocationColumn}
                />
                <ColumnSelect
                  label="Final Transcript Column (Optional)"
                  value={finalTranscriptColumn}
                  columns={columns}
                  onChange={setFinalTranscriptColumn}
                  allowEmptyOption
                  emptyOptionLabel="Leave empty (start final transcript blank)"
                />
              </div>
            </div>

            <div className="oa-card-soft p-4">
              <h4 className="text-sm font-semibold text-[#262240]">Optional Metadata</h4>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ColumnSelect label="Notes" value={notesColumn} columns={columns} onChange={setNotesColumn} />
                <ColumnSelect
                  label="Speaker Gender"
                  value={speakerGenderColumn}
                  columns={columns}
                  onChange={setSpeakerGenderColumn}
                />
                <ColumnSelect
                  label="Speaker Role"
                  value={speakerRoleColumn}
                  columns={columns}
                  onChange={setSpeakerRoleColumn}
                />
                <ColumnSelect label="Language" value={languageColumn} columns={columns} onChange={setLanguageColumn} />
                <ColumnSelect label="Channel" value={channelColumn} columns={columns} onChange={setChannelColumn} />
                <ColumnSelect label="Duration" value={durationColumn} columns={columns} onChange={setDurationColumn} />
              </div>
            </div>
          </div>

          <div className="oa-card-soft p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-[#262240]">Transcript Sources</h4>
              <button
                type="button"
                onClick={() =>
                  setTranscriptMaps((prev) => [
                    ...prev,
                    {
                      source_key: "",
                      source_label: "",
                      column_name: ""
                    }
                  ])
                }
                className="oa-btn-secondary px-2.5 py-1.5 text-xs font-medium"
              >
                Add Source
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {transcriptMaps.map((item, index) => (
                <div
                  key={`${item.source_key}-${index}`}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-[#e5dbf2] bg-white p-2 md:grid-cols-[1fr_1fr_1.2fr_auto]"
                >
                  <input
                    value={item.source_key}
                    onChange={(event) =>
                      setTranscriptMaps((prev) =>
                        prev.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, source_key: event.target.value } : entry
                        )
                      )
                    }
                    className="oa-input"
                    placeholder="source_key"
                  />
                  <input
                    value={item.source_label}
                    onChange={(event) =>
                      setTranscriptMaps((prev) =>
                        prev.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, source_label: event.target.value } : entry
                        )
                      )
                    }
                    className="oa-input"
                    placeholder="source_label"
                  />
                  <select
                    value={item.column_name}
                    onChange={(event) =>
                      setTranscriptMaps((prev) =>
                        prev.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, column_name: event.target.value } : entry
                        )
                      )
                    }
                    className="oa-select"
                  >
                    <option value="">Select transcript column</option>
                    {columns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setTranscriptMaps((prev) => prev.filter((_, entryIndex) => entryIndex !== index))}
                    className="rounded-lg border border-[#f0c8c8] bg-white px-3 py-2 text-xs font-medium text-[#a13a3a] transition hover:bg-[#fff4f4]"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-[#ece3f7] pt-4">
            <button
              type="button"
              onClick={handleValidate}
              disabled={busy}
              className="oa-btn-secondary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              Validate
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={busy || !hasValidation || importBlockedByGates}
              className="oa-btn-primary px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              Import Valid Rows
            </button>
            <span className="text-xs text-[#7a7594]">{busy ? "Processing request..." : "Ready for next action."}</span>
            {!hasValidation ? (
              <span className="rounded-md border border-[#e3d8f3] bg-[#f7f1ff] px-2.5 py-1 text-xs text-[#5e597a]">
                Run validation before import.
              </span>
            ) : null}
            {importBlockedByGates ? (
              <span className="rounded-md border border-[#f0c8c8] bg-[#fff3f3] px-2.5 py-1 text-xs text-[#a13a3a]">
                Import is blocked by failed quick validation gates.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {validationResult ? (
        <div className="oa-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="oa-title text-base font-semibold">Step 3: Validation Result</h3>
            <span
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${validationBadge.className}`}
            >
              {validationBadge.label}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <MetricCard label="Valid Rows" value={validationResult.valid_rows} />
            <MetricCard label="Invalid Rows" value={validationResult.invalid_rows} />
            <MetricCard label="Total Rows" value={validationResult.total_rows} />
          </div>
          <p className="mt-3 rounded-lg border border-[#e3d8f3] bg-[#fbf8ff] px-3 py-2 text-sm text-[#4b4665]">
            {validationResult.valid_rows} of {validationResult.total_rows} rows are ready to import
            {validationResult.invalid_rows > 0 ? `; ${validationResult.invalid_rows} row${validationResult.invalid_rows === 1 ? "" : "s"} need fixes.` : ""}
          </p>

          <div className="mt-4 rounded-lg border border-[#ece3f7] bg-[#faf7ff] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-[#2f2a49]">Quick Validation Gates</h4>
              <span
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  validationResult.import_allowed
                    ? "border border-[#bfe7cf] bg-[#eafaf0] text-[#236140]"
                    : "border border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]"
                }`}
              >
                {validationResult.import_allowed ? "Import Allowed" : "Import Blocked"}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {validationResult.gates.map((gate) => (
                <div key={gate.gate_key} className="rounded-md border border-[#e7ddf3] bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#635d7f]">{formatGateLabel(gate.gate_key)}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        gate.status === "fail"
                          ? "bg-[#ffe7e7] text-[#a13a3a]"
                          : gate.status === "warning"
                            ? "bg-[#fff0da] text-[#9a6118]"
                            : "bg-[#eafaf0] text-[#236140]"
                      }`}
                    >
                      {gate.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#5f5a79]">{gate.message}</p>
                  {gate.checked_count !== null || gate.failed_count !== null ? (
                    <p className="mt-1 text-[11px] text-[#7a7494]">
                      Checked: {gate.checked_count ?? "-"} | Failed: {gate.failed_count ?? "-"}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {validationResult.errors.length > 0 ? (
            <div className="mt-4 overflow-auto rounded-lg border border-[#ece3f7]">
              <table className="w-full text-sm">
                <thead className="bg-[#f9f5ff] text-[#696482]">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Row</th>
                    <th className="px-3 py-2 text-left font-medium">Field</th>
                    <th className="px-3 py-2 text-left font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {validationResult.errors.map((errorItem, index) => (
                    <tr key={`${errorItem.row_number}-${index}`} className="border-t border-[#eee5f7] text-[#2b2646]">
                      <td className="px-3 py-2">{errorItem.row_number}</td>
                      <td className="px-3 py-2">{errorItem.field_name}</td>
                      <td className="px-3 py-2">{errorItem.error_message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-[#bfe7cf] bg-[#eafaf0] px-3 py-2 text-sm text-[#236140]">
              No validation errors.
            </p>
          )}
        </div>
      ) : null}

      {importResult ? (
        <div className="rounded-xl border border-[#bfe7cf] bg-[#eafaf0] p-4 text-sm text-[#1f5f3d]">
          <h3 className="font-semibold">Step 4: Import Complete</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full border border-[#bfe7cf] bg-white px-3 py-1 text-xs font-semibold text-[#236140]">
              {String(importResult.imported_tasks ?? 0)} tasks imported
            </span>
            <span className="rounded-full border border-[#d8c2ef] bg-white px-3 py-1 text-xs font-semibold text-[#533b7f]">
              {String(importResult.skipped_rows ?? 0)} rows skipped
            </span>
            <span className="rounded-full border border-[#d8c2ef] bg-white px-3 py-1 text-xs font-semibold text-[#533b7f]">
              Status: {String(importResult.status ?? importJob?.status ?? "-")}
            </span>
          </div>
        </div>
      ) : null}

      {sampleRows.length > 0 ? (
        <div className="oa-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="oa-title text-base font-semibold">Preview Rows</h3>
            <span className="text-xs text-[#7a7494]">Showing first {Math.min(sampleRows.length, 10)} rows</span>
          </div>
          <div className="mt-3 overflow-auto rounded-lg border border-[#ece3f7]">
            <table className="w-full text-sm">
              <thead className="bg-[#f9f5ff] text-[#696482]">
                <tr>
                  {columns.map((column) => (
                    <th key={column} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.slice(0, 10).map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-[#eee5f7]">
                    {columns.map((column) => (
                      <td key={`${rowIndex}-${column}`} className="px-3 py-2 whitespace-nowrap text-[#2b2646]">
                        {String(row[column] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StepPill({
  title,
  description,
  active,
  complete
}: {
  title: string;
  description: string;
  active: boolean;
  complete: boolean;
}) {
  const className = complete
    ? "border-[#bfe7cf] bg-[#eafaf0]"
    : active
      ? "border-[#d8c2ef] bg-[#f3ebff]"
      : "border-[#e4d9f3] bg-white";

  const titleClassName = complete ? "text-[#236140]" : active ? "text-[#57338a]" : "text-[#5f5a79]";

  return (
    <div className={`rounded-xl border px-3 py-2 ${className}`}>
      <p className={`text-xs font-semibold ${titleClassName}`}>{title}</p>
      <p className="mt-0.5 text-xs text-[#736d8d]">{description}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="oa-card-soft px-3 py-2">
      <p className="text-xs text-[#736d8d]">{label}</p>
      <p className="text-base font-semibold text-[#23203f]">{value}</p>
    </div>
  );
}

function formatUserTimestamp(value: string | null, emptyLabel: string) {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function assignmentLoadClass(load: AdminUser["assignment_load"]) {
  if (load === "heavy") return "bg-[#ffe7e7] text-[#9a312f]";
  if (load === "normal") return "bg-[#fff0da] text-[#8b5a17]";
  if (load === "light") return "bg-[#eafaf0] text-[#236140]";
  return "bg-[#eeedf5] text-[#5d5875]";
}

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
  allowEmptyOption = true,
  emptyOptionLabel = "Select column",
}: {
  label: string;
  value: string;
  columns: string[];
  onChange: (value: string) => void;
  allowEmptyOption?: boolean;
  emptyOptionLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[#676280]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="oa-select">
        {allowEmptyOption ? <option value="">{emptyOptionLabel}</option> : null}
        {columns.map((column) => (
          <option key={column} value={column}>
            {column}
          </option>
        ))}
      </select>
    </label>
  );
}

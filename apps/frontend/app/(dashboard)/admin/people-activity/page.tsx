"use client";

import type { AdminUser, PeopleActivityResponse, PeopleActivitySummary } from "@outcomes/shared-types";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { PeopleMultiSelect } from "@/components/people-multi-select";
import { exportPeopleActivity, fetchPeopleActivity, fetchUsers } from "@/lib/api";

interface ActivityFilters {
  userIds: string[];
  dateFrom: string;
  dateTo: string;
}

function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultFilters(): ActivityFilters {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo);
  dateFrom.setDate(dateFrom.getDate() - 6);
  return {
    userIds: [],
    dateFrom: dateInputValue(dateFrom),
    dateTo: dateInputValue(dateTo),
  };
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${safeSeconds}s`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "No activity";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "No activity" : parsed.toLocaleString();
}

function formatOptional(value: number | null, suffix = ""): string {
  return value === null ? "-" : `${value.toFixed(2)}${suffix}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function MetricCells({ summary }: { summary: PeopleActivitySummary }) {
  return (
    <>
      <td className="whitespace-nowrap px-3 py-3 font-semibold text-[#241f43]">
        {formatDuration(summary.active_seconds)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[#55506d]">
        {formatDuration(summary.task_active_seconds)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[#55506d]">
        {formatDuration(summary.idle_seconds)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 font-semibold text-[#241f43]">
        {summary.completed_segments}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[#55506d]">
        {summary.average_active_seconds_per_segment === null
          ? "-"
          : formatDuration(summary.average_active_seconds_per_segment)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[#55506d]">
        {formatOptional(summary.efficiency_segments_per_active_hour, "/hr")}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[#55506d]">
        {summary.focus_rate === null ? "-" : `${(summary.focus_rate * 100).toFixed(1)}%`}
      </td>
      <td className="min-w-[170px] px-3 py-3 text-[#706a87]">{formatDateTime(summary.last_activity_at)}</td>
    </>
  );
}

export default function PeopleActivityPage() {
  const { accessToken, user } = useAuth();
  const initialFilters = useMemo(defaultFilters, []);
  const [filters, setFilters] = useState<ActivityFilters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<ActivityFilters>(initialFilters);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [report, setReport] = useState<PeopleActivityResponse | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    if (!accessToken || user?.role !== "ADMIN") return;
    setLoading(true);
    setError(null);
    try {
      const [userResponse, activityResponse] = await Promise.all([
        fetchUsers(accessToken, { scope: "all" }),
        fetchPeopleActivity(accessToken, {
          userIds: appliedFilters.userIds,
          dateFrom: appliedFilters.dateFrom,
          dateTo: appliedFilters.dateTo,
        }),
      ]);
      setUsers(userResponse.items);
      setReport(activityResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load people activity.");
    } finally {
      setLoading(false);
    }
  }, [accessToken, appliedFilters, user?.role]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const totals = useMemo(() => {
    const items = report?.items ?? [];
    return {
      people: items.length,
      active: items.reduce((sum, item) => sum + item.overall.active_seconds, 0),
      idle: items.reduce((sum, item) => sum + item.overall.idle_seconds, 0),
      completed: items.reduce((sum, item) => sum + item.overall.completed_segments, 0),
    };
  }, [report]);

  function applyFilters(): void {
    if (filters.dateFrom > filters.dateTo) {
      setError("From date must be on or before to date.");
      return;
    }
    setAppliedFilters({ ...filters, userIds: [...filters.userIds] });
  }

  async function handleExport(): Promise<void> {
    if (!accessToken) return;
    setExporting(true);
    setError(null);
    try {
      const result = await exportPeopleActivity(accessToken, {
        userIds: appliedFilters.userIds,
        dateFrom: appliedFilters.dateFrom,
        dateTo: appliedFilters.dateTo,
      });
      downloadBlob(result.blob, result.filename);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Could not export people activity.");
    } finally {
      setExporting(false);
    }
  }

  function toggleUser(userId: string): void {
    setExpandedUsers((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <section className="oa-card px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#7a7193]">Admin report</p>
            <h2 className="oa-title mt-1 text-2xl font-semibold">People Activity</h2>
            <p className="mt-1 text-sm text-[#68627e]">Combined work time across every organization.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-4 lg:min-w-[760px]">
            <div className="text-xs font-semibold text-[#5f5878]">
              <span>People</span>
              <PeopleMultiSelect
                users={users}
                selectedIds={filters.userIds}
                onChange={(userIds) => setFilters((current) => ({ ...current, userIds }))}
              />
            </div>
            <label className="text-xs font-semibold text-[#5f5878]">
              From
              <input
                aria-label="From"
                className="oa-input mt-1 w-full"
                type="date"
                value={filters.dateFrom}
                onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
              />
            </label>
            <label className="text-xs font-semibold text-[#5f5878]">
              To
              <input
                aria-label="To"
                className="oa-input mt-1 w-full"
                type="date"
                value={filters.dateTo}
                onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
              />
            </label>
            <div className="flex items-end gap-2">
              <button className="oa-btn-primary flex-1" type="button" onClick={applyFilters}>
                Apply
              </button>
              <button
                className="oa-btn-secondary whitespace-nowrap"
                type="button"
                disabled={exporting || loading}
                onClick={() => void handleExport()}
              >
                {exporting ? "Exporting..." : "Export CSV"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {error ? <div className="oa-alert-error">{error}</div> : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["People", totals.people.toLocaleString()],
          ["Active time", formatDuration(totals.active)],
          ["Idle time", formatDuration(totals.idle)],
          ["Segments done", totals.completed.toLocaleString()],
        ].map(([label, value]) => (
          <div className="oa-card px-4 py-3" key={label}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#7a7193]">{label}</p>
            <p className="mt-1 text-xl font-semibold text-[#241f43]">{loading ? "..." : value}</p>
          </div>
        ))}
      </section>

      <section className="oa-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#ece5f4] px-5 py-3">
          <div>
            <h3 className="font-semibold text-[#241f43]">Last 7 days by person</h3>
            <p className="text-xs text-[#706a87]">Expand a person to see each organization contribution.</p>
          </div>
          <span className="text-xs text-[#706a87]">
            {report ? `${report.date_from} to ${report.date_to}` : "Loading"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] text-left text-sm">
            <thead className="bg-[#faf7fd] text-[11px] uppercase tracking-[0.1em] text-[#746c8d]">
              <tr>
                <th className="px-3 py-3">Person</th>
                <th className="px-3 py-3">Active</th>
                <th className="px-3 py-3">Task time</th>
                <th className="px-3 py-3">Idle</th>
                <th className="px-3 py-3">Done</th>
                <th className="px-3 py-3">Avg / segment</th>
                <th className="px-3 py-3">Efficiency</th>
                <th className="px-3 py-3">Focus</th>
                <th className="px-3 py-3">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eee8f5]">
              {loading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[#706a87]" colSpan={9}>Loading activity...</td>
                </tr>
              ) : report?.items.length ? (
                report.items.map((item) => {
                  const expanded = expandedUsers.has(item.user_id);
                  return (
                    <Fragment key={item.user_id}>
                      <tr className="bg-white">
                        <td className="min-w-[230px] px-3 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              aria-expanded={expanded}
                              aria-label={`${expanded ? "Hide" : "Show"} organization breakdown for ${item.user_name}`}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#ded3ee] text-[#4f476e]"
                              type="button"
                              onClick={() => toggleUser(item.user_id)}
                            >
                              {expanded ? "−" : "+"}
                            </button>
                            <div>
                              <p className="font-semibold text-[#241f43]">{item.user_name}</p>
                              <p className="text-xs text-[#706a87]">{item.user_email} · {item.role}</p>
                            </div>
                          </div>
                        </td>
                        <MetricCells summary={item.overall} />
                      </tr>
                      {expanded
                        ? item.organizations.map((organization) => (
                            <tr className="bg-[#fbf9fd]" key={`${item.user_id}-${organization.organization_id}`}>
                              <td className="px-3 py-3 pl-12">
                                <p className="font-semibold text-[#4f476e]">{organization.organization_name}</p>
                                <p className="text-xs text-[#817a96]">
                                  {formatDuration(organization.task_active_seconds)} task time
                                </p>
                              </td>
                              <MetricCells summary={organization} />
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  );
                })
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-[#706a87]" colSpan={9}>
                    No activity was recorded for this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

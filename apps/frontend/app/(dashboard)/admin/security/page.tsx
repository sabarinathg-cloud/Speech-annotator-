"use client";

import type { SecurityAuditEvent } from "@outcomes/shared-types";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useAuth } from "@/components/auth-provider";
import { APIError, fetchSecurityAuditEvents } from "@/lib/api";

const actionOptions = [
  "all",
  "VIEW_TASK",
  "GENERATE_AUDIO_URL",
  "STREAM_AUDIO",
  "MASK_PII_AUDIO",
  "EXPORT_TASKS",
  "ENQUEUE_EXPORT_JOB",
  "DOWNLOAD_JOB_OUTPUT",
  "ACKNOWLEDGE_CONFIDENTIALITY",
];

const riskOptions = ["all", "low", "medium", "high"];

function formatEventTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function riskClass(risk: string): string {
  if (risk === "high") return "border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]";
  if (risk === "medium") return "border-[#f1dfb6] bg-[#fff7e6] text-[#8a5b1e]";
  return "border-[#d9eadf] bg-[#edf8f0] text-[#236140]";
}

function metadataSummary(event: SecurityAuditEvent): string {
  const entries = Object.entries(event.metadata ?? {});
  if (entries.length === 0) return "No metadata";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value ?? "-")}`)
    .join(" | ");
}

export default function AdminSecurityPage() {
  const { accessToken, user } = useAuth();
  const [action, setAction] = useState("all");
  const [riskLevel, setRiskLevel] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchSecurityAuditEvents>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startTransition] = useTransition();
  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    if (!accessToken || !isAdmin) return;
    startTransition(async () => {
      try {
        const response = await fetchSecurityAuditEvents(accessToken, {
          action: action === "all" ? null : action,
          riskLevel: riskLevel === "all" ? null : riskLevel,
          page,
          pageSize: 25,
        });
        setData(response);
        setError(null);
      } catch (err) {
        setError(err instanceof APIError ? err.message : "Failed to load security events");
      }
    });
  }, [accessToken, action, isAdmin, page, riskLevel]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.page_size));
  }, [data]);

  if (!isAdmin) {
    return (
      <section className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">
        Admin role is required to view security events.
      </section>
    );
  }

  return (
    <section className="animate-fade-in space-y-4">
      <div className="oa-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#797590]">Governance</p>
            <h2 className="oa-title mt-1 text-xl font-semibold">Security Audit</h2>
            <p className="oa-subtext mt-1 text-sm">
              Monitor sensitive actions such as task views, audio streams, masking, and exports.
            </p>
          </div>
          <span className="rounded-full border border-[#e6dcf2] bg-[#fbf8ff] px-3 py-1 text-xs font-semibold text-[#514a70]">
            {data ? `${data.total} events` : "Loading events"}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Action</span>
            <select
              aria-label="Action"
              value={action}
              onChange={(event) => {
                setPage(1);
                setAction(event.target.value);
              }}
              className="oa-select"
            >
              {actionOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All actions" : option}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#676280]">Risk</span>
            <select
              aria-label="Risk"
              value={riskLevel}
              onChange={(event) => {
                setPage(1);
                setRiskLevel(event.target.value);
              }}
              className="oa-select"
            >
              {riskOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All risk levels" : option}
                </option>
              ))}
            </select>
          </label>

          <div className="oa-card-soft flex flex-col justify-center px-3 py-2">
            <span className="text-xs font-medium text-[#676280]">Status</span>
            <span className="mt-0.5 text-sm font-medium text-[#201d3f]">
              {loading ? "Refreshing..." : "Audit trail active"}
            </span>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">{error}</div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-[#e6dcf2] bg-white shadow-[0_22px_48px_-42px_rgba(15,23,42,0.45)]">
        <table className="min-w-full divide-y divide-[#eee7f7] text-left text-sm">
          <thead className="bg-[#fbf8ff] text-xs uppercase tracking-[0.08em] text-[#6d6685]">
            <tr>
              <th className="px-4 py-3 font-semibold">Time</th>
              <th className="px-4 py-3 font-semibold">Action</th>
              <th className="px-4 py-3 font-semibold">Risk</th>
              <th className="px-4 py-3 font-semibold">Actor</th>
              <th className="px-4 py-3 font-semibold">Resource</th>
              <th className="px-4 py-3 font-semibold">Metadata</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0edf6]">
            {(data?.items ?? []).map((event) => (
              <tr key={event.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-3 text-[#5f5b79]">{formatEventTime(event.created_at)}</td>
                <td className="px-4 py-3 font-semibold text-[#241f43]">{event.action}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${riskClass(event.risk_level)}`}>
                    {event.risk_level}
                  </span>
                </td>
                <td className="px-4 py-3 text-[#5f5b79]">
                  <div className="font-medium text-[#2d2948]">{event.actor_email ?? "Signed token"}</div>
                  <div className="text-xs">{event.actor_role ?? "unknown"}</div>
                </td>
                <td className="px-4 py-3 text-[#5f5b79]">
                  <div>{event.resource_type}</div>
                  <div className="max-w-[180px] truncate text-xs">{event.resource_id ?? event.task_id ?? "-"}</div>
                </td>
                <td className="max-w-[260px] truncate px-4 py-3 text-[#5f5b79]">{metadataSummary(event)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-[#6b6682]">
                  No security events match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-[#6b6682]">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="oa-btn-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            className="oa-btn-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}

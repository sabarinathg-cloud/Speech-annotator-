"use client";

import Link from "next/link";
import type { AdminMetricsResponse, AdminUser, ModelBenchmarkMetric, PIILabel, TaskStatus } from "@outcomes/shared-types";
import { useEffect, useMemo, useState } from "react";

import { AnimatedMetricNumber } from "@/components/animated-metric-number";
import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import {
  APIError,
  createPIILabel,
  fetchAdminMetrics,
  fetchAdminPIILabels,
  fetchUsers,
  updatePIILabel,
} from "@/lib/api";

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

interface MetricFilters {
  status: TaskStatus | "All";
  assigneeId: string;
  jobId: string;
  language: string;
  dateFrom: string;
  dateTo: string;
}

interface LabelDraft {
  display_name: string;
  color: string;
  description: string;
  is_active: boolean;
  sort_order: number;
}

const emptyFilters: MetricFilters = {
  status: "All",
  assigneeId: "all",
  jobId: "",
  language: "",
  dateFrom: "",
  dateTo: "",
};

function formatPercentValue(value: number): string {
  return `${value.toFixed(1)}%`;
}

function percentValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value * 100;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatMilliseconds(value: number): string {
  return `${formatInteger(value)} ms`;
}

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${formatInteger(value)} min`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

function formatDecimal2(value: number): string {
  return value.toFixed(2);
}

function formatRateValue(value: number): string {
  return value.toFixed(4);
}

function labelDraftFrom(label: PIILabel): LabelDraft {
  return {
    display_name: label.display_name,
    color: label.color,
    description: label.description ?? "",
    is_active: label.is_active,
    sort_order: label.sort_order,
  };
}

export default function AdminMetricsPage() {
  const { accessToken, user } = useAuth();
  const [metrics, setMetrics] = useState<AdminMetricsResponse | null>(null);
  const [labels, setLabels] = useState<PIILabel[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, LabelDraft>>({});
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filters, setFilters] = useState<MetricFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<MetricFilters>(emptyFilters);
  const [newLabelKey, setNewLabelKey] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#0f766e");
  const [newLabelDescription, setNewLabelDescription] = useState("");
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [labelBusy, setLabelBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const canAdmin = user?.role === "ADMIN";

  const metricCards = useMemo(() => {
    const overview = metrics?.overview;
    return [
      { label: "Tasks", value: overview?.total_tasks ?? 0, format: formatInteger, detail: "matching filters" },
      {
        label: "Scored Tasks",
        value: overview?.scored_tasks ?? 0,
        format: formatInteger,
        detail: `${overview?.scored_pairs ?? 0} source pairs`,
      },
      {
        label: "Average WER",
        value: percentValue(overview?.average_wer),
        format: formatPercentValue,
        detail: "corrected transcript as ground truth",
      },
      {
        label: "Average CER",
        value: percentValue(overview?.average_cer),
        format: formatPercentValue,
        detail: "character-level error",
      },
      {
        label: "PII Entities",
        value: overview?.total_pii_annotations ?? 0,
        format: formatInteger,
        detail: `${overview?.low_confidence_annotations ?? 0} low confidence`,
      },
      {
        label: "Overlap Warnings",
        value: overview?.overlap_warnings ?? 0,
        format: formatInteger,
        detail: "PII spans needing review",
      },
    ];
  }, [metrics]);

  const maskingMetricCards = useMemo(() => {
    const masking = metrics?.masking_metrics;
    return [
      {
        label: "Onset Error",
        value: masking?.average_onset_error_ms ?? null,
        format: formatMilliseconds,
        detail: "mean accepted-start error",
      },
      {
        label: "Offset Error",
        value: masking?.average_offset_error_ms ?? null,
        format: formatMilliseconds,
        detail: "mean accepted-end error",
      },
      {
        label: "Leaked Audio",
        value: masking?.leaked_audio_duration_ms ?? 0,
        format: formatMilliseconds,
        detail: "accepted PII left unmasked",
      },
      {
        label: "Over-Masked Audio",
        value: masking?.over_masked_duration_ms ?? 0,
        format: formatMilliseconds,
        detail: "audio outside accepted windows",
      },
    ];
  }, [metrics]);

  const alignmentAdjustmentCards = useMemo(() => {
    const masking = metrics?.masking_metrics;
    return [
      {
        label: "Adjusted Tasks",
        value: masking?.alignment_adjusted_tasks ?? 0,
        format: formatInteger,
        detail: "human timing corrections",
      },
      {
        label: "Onset Adjustment",
        value: masking?.average_alignment_onset_adjustment_ms ?? null,
        format: formatMilliseconds,
        detail: "mean auto-to-accepted start delta",
      },
      {
        label: "Offset Adjustment",
        value: masking?.average_alignment_offset_adjustment_ms ?? null,
        format: formatMilliseconds,
        detail: "mean auto-to-accepted end delta",
      },
      {
        label: "Trimmed From Auto",
        value: masking?.alignment_trimmed_duration_ms ?? 0,
        format: formatMilliseconds,
        detail: "auto mask removed by humans",
      },
      {
        label: "Expanded Beyond Auto",
        value: masking?.alignment_expanded_duration_ms ?? 0,
        format: formatMilliseconds,
        detail: "PII added beyond auto timing",
      },
    ];
  }, [metrics]);

  useEffect(() => {
    if (!accessToken || !canAdmin) return;
    let cancelled = false;

    async function loadAdminLookups() {
      try {
        const [labelResponse, userResponse] = await Promise.all([
          fetchAdminPIILabels(accessToken as string),
          fetchUsers(accessToken as string),
        ]);
        if (cancelled) return;
        setLabels(labelResponse.items);
        setLabelDrafts(Object.fromEntries(labelResponse.items.map((label) => [label.id, labelDraftFrom(label)])));
        setUsers(userResponse.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Failed to load admin lookups");
      }
    }

    void loadAdminLookups();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canAdmin]);

  useEffect(() => {
    if (!accessToken || !canAdmin) return;
    let cancelled = false;

    async function loadMetrics() {
      setLoadingMetrics(true);
      setError(null);
      try {
        const data = await fetchAdminMetrics(accessToken as string, {
          status: appliedFilters.status,
          assigneeId: appliedFilters.assigneeId === "all" ? null : appliedFilters.assigneeId,
          jobId: appliedFilters.jobId.trim() || null,
          language: appliedFilters.language.trim() || null,
          dateFrom: appliedFilters.dateFrom || null,
          dateTo: appliedFilters.dateTo || null,
        });
        if (!cancelled) setMetrics(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Failed to load metrics");
      } finally {
        if (!cancelled) setLoadingMetrics(false);
      }
    }

    void loadMetrics();
    return () => {
      cancelled = true;
    };
  }, [accessToken, appliedFilters, canAdmin]);

  async function reloadLabels() {
    if (!accessToken) return;
    const response = await fetchAdminPIILabels(accessToken);
    setLabels(response.items);
    setLabelDrafts(Object.fromEntries(response.items.map((label) => [label.id, labelDraftFrom(label)])));
  }

  async function handleCreateLabel() {
    if (!accessToken || !newLabelKey.trim() || !newLabelName.trim()) return;
    setLabelBusy(true);
    setError(null);
    setMessage(null);
    try {
      await createPIILabel(accessToken, {
        key: newLabelKey,
        display_name: newLabelName,
        color: newLabelColor,
        description: newLabelDescription.trim() || null,
      });
      setNewLabelKey("");
      setNewLabelName("");
      setNewLabelColor("#0f766e");
      setNewLabelDescription("");
      setMessage("PII label added.");
      await reloadLabels();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to create PII label");
    } finally {
      setLabelBusy(false);
    }
  }

  async function handleSaveLabel(label: PIILabel) {
    if (!accessToken) return;
    const draft = labelDrafts[label.id];
    if (!draft) return;
    setLabelBusy(true);
    setError(null);
    setMessage(null);
    try {
      await updatePIILabel(accessToken, label.id, {
        display_name: draft.display_name,
        color: draft.color,
        description: draft.description.trim() || null,
        is_active: draft.is_active,
        sort_order: Number(draft.sort_order),
      });
      setMessage("PII label saved.");
      await reloadLabels();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update PII label");
    } finally {
      setLabelBusy(false);
    }
  }

  const statusBreakdown = Object.entries(metrics?.status_counts ?? {}).sort(([first], [second]) =>
    first.localeCompare(second)
  );
  const piiLabelBreakdown = Object.entries(metrics?.pii_metrics.by_label ?? {});
  const piiSourceBreakdown = Object.entries(metrics?.pii_metrics.by_source ?? {});

  if (!canAdmin) {
    return (
      <div className="oa-card p-5">
        <h2 className="oa-title text-lg font-semibold">Admin Metrics</h2>
        <p className="mt-2 text-sm text-[#6b7280]">Only admins can view metrics and manage PII labels.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="oa-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7c7895]">Admin Metrics</p>
            <h2 className="oa-title text-2xl font-semibold">Quality and Productivity Dashboard</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#6b7280]">
              Track transcript accuracy, PII tagging, audio masking quality, and tagger activity from one filtered view.
            </p>
          </div>
          <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-xs text-[#6b7280]">
            {metrics ? `Updated ${new Date(metrics.generated_at).toLocaleString()}` : "Loading metrics..."}
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#991b1b]">{error}</div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-[#bbf7d0] bg-[#f0fdf4] px-4 py-3 text-sm text-[#166534]">{message}</div>
      ) : null}

      <section className="space-y-3">
        <SectionHeading
          eyebrow="Snapshot"
          title="Filtered Overview"
          description="These headline numbers all use the current filter scope."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {metricCards.map((card) => (
            <MetricSummaryCard
              key={card.label}
              label={card.label}
              value={card.value}
              format={card.format}
              detail={card.detail}
              loading={loadingMetrics}
            />
          ))}
        </div>
        <BreakdownCard
          title="Task Status Breakdown"
          items={statusBreakdown}
          emptyMessage="No tasks match these filters."
          formatValue={formatInteger}
        />
      </section>

      <section className="oa-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="oa-title text-sm font-semibold">Filters</h3>
          <button
            type="button"
            onClick={() => setAppliedFilters(filters)}
            className="oa-btn-primary px-3 py-1.5 text-xs font-medium"
          >
            Apply Filters
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs font-medium text-[#4b5563]">
            Status
            <select
              aria-label="Status"
              value={filters.status}
              onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value as TaskStatus | "All" }))}
              className="oa-select mt-1 w-full"
            >
              {taskStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-[#4b5563]">
            Assignee
            <select
              aria-label="Assignee"
              value={filters.assigneeId}
              onChange={(event) => setFilters((prev) => ({ ...prev, assigneeId: event.target.value }))}
              className="oa-select mt-1 w-full"
            >
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {users.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-[#4b5563]">
            Language
            <input
              aria-label="Language"
              value={filters.language}
              onChange={(event) => setFilters((prev) => ({ ...prev, language: event.target.value }))}
              className="oa-input mt-1 w-full"
              placeholder="Language code"
            />
          </label>
          <label className="text-xs font-medium text-[#4b5563]">
            Upload Job
            <input
              aria-label="Upload Job"
              value={filters.jobId}
              onChange={(event) => setFilters((prev) => ({ ...prev, jobId: event.target.value }))}
              className="oa-input mt-1 w-full"
              placeholder="Upload job ID"
            />
          </label>
          <label className="text-xs font-medium text-[#4b5563]">
            From
            <input
              aria-label="From"
              type="date"
              value={filters.dateFrom}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateFrom: event.target.value }))}
              className="oa-input mt-1 w-full"
            />
          </label>
          <label className="text-xs font-medium text-[#4b5563]">
            To
            <input
              aria-label="To"
              type="date"
              value={filters.dateTo}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateTo: event.target.value }))}
              className="oa-input mt-1 w-full"
            />
          </label>
        </div>
      </section>

      <SectionHeading
        eyebrow="Audio"
        title="Audio Masking Quality"
        description="Review masked audio timing, leaked PII risk, and human timing adjustments."
      />

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <div className="oa-card p-4">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="oa-title text-sm font-semibold">Masking Summary</h3>
              <p className="text-xs text-[#6b7280]">
                {`${metrics?.masking_metrics.scored_masked_tasks ?? 0} scored / ${metrics?.masking_metrics.unscored_masked_tasks ?? 0} unscored masked tasks`}
              </p>
            </div>
            <div className="text-xs text-[#6b7280]">
              <AnimatedMetricNumber
                loading={loadingMetrics}
                value={metrics?.masking_metrics.scored_intervals ?? 0}
                format={formatInteger}
              />{" "}
              scored intervals
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {maskingMetricCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">{card.label}</div>
                <AnimatedMetricNumber
                  loading={loadingMetrics}
                  value={card.value}
                  format={card.format}
                  className="mt-2 block text-2xl font-semibold text-[#111827]"
                />
                <div className="mt-1 text-xs text-[#6b7280]">{card.detail}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-[#e5e7eb] pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6b7280]">Auto Alignment Adjustment</h4>
              <span className="text-xs text-[#6b7280]">
                <AnimatedMetricNumber
                  loading={loadingMetrics}
                  value={metrics?.masking_metrics.alignment_adjusted_intervals ?? 0}
                  format={formatInteger}
                />{" "}
                adjusted intervals
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
              {alignmentAdjustmentCards.map((card) => (
                <div key={card.label} className="rounded-lg border border-[#dbeafe] bg-[#eff6ff] px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1d4ed8]">{card.label}</div>
                  <AnimatedMetricNumber
                    loading={loadingMetrics}
                    value={card.value}
                    format={card.format}
                    className="mt-2 block text-xl font-semibold text-[#111827]"
                  />
                  <div className="mt-1 text-xs text-[#475569]">{card.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="oa-card p-4">
          <h3 className="oa-title mb-3 text-sm font-semibold">Highest Masking Risk Tasks</h3>
          <div className="space-y-2">
            {(metrics?.worst_masking_tasks ?? []).slice(0, 6).map((task) => (
              <div key={task.task_id} className="rounded-lg border border-[#e5e7eb] bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link href={`/tasks/${task.task_id}`} className="text-sm font-semibold text-[#2563eb] hover:underline">
                      {task.external_id}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6b7280]">
                      <StatusBadge status={task.status} />
                      <span>{task.language ?? "Language not set"}</span>
                      <span>{task.last_tagger_name ?? "No tagger recorded"}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-[#6b7280]">Risk</div>
                    <div className="text-lg font-semibold text-[#111827]">
                      <AnimatedMetricNumber value={task.risk_duration_ms} format={formatMilliseconds} />
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-full border border-[#fee2e2] bg-[#fef2f2] px-2 py-0.5 text-xs text-[#991b1b]">
                    Leaked: <AnimatedMetricNumber value={task.leaked_audio_duration_ms} format={formatMilliseconds} />
                  </span>
                  <span className="rounded-full border border-[#ffedd5] bg-[#fff7ed] px-2 py-0.5 text-xs text-[#9a3412]">
                    Over-masked: <AnimatedMetricNumber value={task.over_masked_duration_ms} format={formatMilliseconds} />
                  </span>
                  <span className="rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-2 py-0.5 text-xs text-[#4b5563]">
                    {task.scored_intervals} interval{task.scored_intervals === 1 ? "" : "s"}
                  </span>
                  <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2 py-0.5 text-xs text-[#1d4ed8]">
                    Alignment adj: <AnimatedMetricNumber value={task.alignment_adjustment_ms} format={formatMilliseconds} />
                  </span>
                </div>
              </div>
            ))}
            {metrics?.worst_masking_tasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">
                No scored audio masking windows match these filters.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="oa-card p-4">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="oa-title text-sm font-semibold">Masking Metric Drilldown</h3>
            <p className="text-xs text-[#6b7280]">Each row links timing risk back to the exact task, label, and window.</p>
          </div>
          <span className="text-xs text-[#6b7280]">{metrics?.masking_interval_drilldowns.length ?? 0} intervals</span>
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.08em] text-[#6b7280]">
              <tr>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Auto</th>
                <th className="px-3 py-2">Accepted</th>
                <th className="px-3 py-2">Actual</th>
                <th className="px-3 py-2">Quality</th>
                <th className="px-3 py-2">Adjustment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eef2f7]">
              {(metrics?.masking_interval_drilldowns ?? []).slice(0, 12).map((item) => (
                <tr key={`${item.task_id}-${item.interval_id ?? item.text}-${item.accepted_start_seconds}`}>
                  <td className="px-3 py-2">
                    <Link href={`/tasks/${item.task_id}`} className="font-semibold text-[#2563eb] hover:underline">
                      {item.external_id}
                    </Link>
                    <div className="text-xs text-[#6b7280]">{item.language ?? "Language not set"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-[#111827]">{item.label}</div>
                    <div className="max-w-[220px] truncate text-xs text-[#6b7280]">{item.text || "No text"}</div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    {item.alignment_start_seconds !== null && item.alignment_end_seconds !== null
                      ? `${item.alignment_start_seconds.toFixed(2)}-${item.alignment_end_seconds.toFixed(2)}s`
                      : "Not scored"}
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    {item.accepted_start_seconds.toFixed(2)}-{item.accepted_end_seconds.toFixed(2)}s
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    {item.actual_start_seconds.toFixed(2)}-{item.actual_end_seconds.toFixed(2)}s
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    <div>Leak <AnimatedMetricNumber value={item.leaked_audio_duration_ms} format={formatMilliseconds} /></div>
                    <div>Over <AnimatedMetricNumber value={item.over_masked_duration_ms} format={formatMilliseconds} /></div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    <div>Trim <AnimatedMetricNumber value={item.alignment_trimmed_duration_ms} format={formatMilliseconds} /></div>
                    <div>Expand <AnimatedMetricNumber value={item.alignment_expanded_duration_ms} format={formatMilliseconds} /></div>
                  </td>
                </tr>
              ))}
              {metrics?.masking_interval_drilldowns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-5 text-center text-sm text-[#6b7280]">
                    No scored masking intervals match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <SectionHeading
        eyebrow="Transcript Quality"
        title="Model Accuracy"
        description="WER and CER compare each ASR source against the corrected final transcript."
      />

      <section className="oa-card p-4">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="oa-title text-sm font-semibold">Model Benchmarking</h3>
            <p className="text-xs text-[#6b7280]">Ranks ASR sources by the same macro-average WER/CER values shown below.</p>
          </div>
          <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-sm">
            <span className="text-xs text-[#6b7280]">Best Model</span>{" "}
            <span className="ml-1 font-semibold text-[#111827]">
              {metrics?.model_benchmarks.best_model_source_label ?? "No data"}
            </span>
            {metrics?.model_benchmarks.best_model_average_wer !== null &&
            metrics?.model_benchmarks.best_model_average_wer !== undefined ? (
              <span className="ml-2 text-[#4b5563]">
                <AnimatedMetricNumber
                  value={percentValue(metrics.model_benchmarks.best_model_average_wer)}
                  format={formatPercentValue}
                />{" "}
                WER
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <BenchmarkTable
            title="Overall Ranking"
            rows={metrics?.model_benchmarks.ranking ?? []}
            formatPercentValue={formatPercentValue}
            percentValue={percentValue}
          />
          <BenchmarkTable
            title="By Language"
            rows={(metrics?.model_benchmarks.by_language ?? []).slice(0, 8)}
            showGroup
            formatPercentValue={formatPercentValue}
            percentValue={percentValue}
          />
          <BenchmarkTable
            title="By Duration"
            rows={(metrics?.model_benchmarks.by_duration_bucket ?? []).slice(0, 8)}
            showGroup
            formatPercentValue={formatPercentValue}
            percentValue={percentValue}
          />
        </div>
      </section>

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="oa-card p-4">
          <h3 className="oa-title mb-3 text-sm font-semibold">Source Accuracy Table</h3>
          <div className="overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.08em] text-[#6b7280]">
                <tr>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Tasks</th>
                  <th className="px-3 py-2">WER</th>
                  <th className="px-3 py-2">CER</th>
                  <th className="px-3 py-2">Word Edits</th>
                  <th className="px-3 py-2">Char Edits</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eef2f7]">
                {(metrics?.model_metrics ?? []).map((item) => (
                  <tr key={item.source_key}>
                    <td className="px-3 py-2 font-medium text-[#111827]">{item.source_label}</td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.tasks_scored} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={percentValue(item.average_wer)} format={formatPercentValue} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={percentValue(item.average_cer)} format={formatPercentValue} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.word_errors} format={formatInteger} />
                      <span>/</span>
                      <AnimatedMetricNumber value={item.reference_words} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.character_errors} format={formatInteger} />
                      <span>/</span>
                      <AnimatedMetricNumber value={item.reference_characters} format={formatInteger} />
                    </td>
                  </tr>
                ))}
                {metrics?.model_metrics.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-5 text-center text-sm text-[#6b7280]">
                      No corrected transcripts with model sources match these filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="oa-card p-4">
          <h3 className="oa-title mb-3 text-sm font-semibold">PII Metrics</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
              <div className="text-xs text-[#6b7280]">Average per task</div>
              <div className="mt-1 text-xl font-semibold text-[#111827]">
                <AnimatedMetricNumber
                  loading={loadingMetrics}
                  value={metrics ? metrics.pii_metrics.average_annotations_per_task : null}
                  format={formatDecimal2}
                />
              </div>
            </div>
            <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
              <div className="text-xs text-[#6b7280]">Low confidence</div>
              <div className="mt-1 text-xl font-semibold text-[#111827]">
                <AnimatedMetricNumber
                  loading={loadingMetrics}
                  value={metrics ? metrics.pii_metrics.low_confidence_annotations : null}
                  format={formatInteger}
                />
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6b7280]">By Label</h4>
            {piiLabelBreakdown.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
                <span className="text-sm font-medium text-[#111827]">{label}</span>
                <AnimatedMetricNumber value={count} format={formatInteger} className="text-sm text-[#4b5563]" />
              </div>
            ))}
            {piiLabelBreakdown.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">
                No PII annotations match these filters.
              </p>
            ) : null}
          </div>
          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6b7280]">By Source</h4>
            {piiSourceBreakdown.map(([source, count]) => (
              <div key={source} className="flex items-center justify-between rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
                <span className="text-sm font-medium capitalize text-[#111827]">{source}</span>
                <AnimatedMetricNumber value={count} format={formatInteger} className="text-sm text-[#4b5563]" />
              </div>
            ))}
            {piiSourceBreakdown.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">
                No PII sources match these filters.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <SectionHeading
        eyebrow="People"
        title="Tagger Activity and Exceptions"
        description="Review contributor activity next to the tasks that need the most transcript-quality attention."
      />

      <section className="oa-card p-4">
        <h3 className="oa-title mb-3 text-sm font-semibold">User Productivity Metrics</h3>
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.08em] text-[#6b7280]">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Assigned</th>
                <th className="px-3 py-2">Touched</th>
                <th className="px-3 py-2">Completed</th>
                <th className="px-3 py-2">Reviewed</th>
                <th className="px-3 py-2">Approved</th>
                <th className="px-3 py-2">Avg Time</th>
                <th className="px-3 py-2">Session</th>
                <th className="px-3 py-2">Security</th>
                <th className="px-3 py-2">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eef2f7]">
              {(metrics?.user_metrics ?? []).map((item) => (
                <tr key={item.user_id}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-[#111827]">{item.user_name}</div>
                    <div className="text-xs text-[#6b7280]">
                      {item.user_email} - {item.role}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    {item.assigned_tasks} total / {item.open_assigned_tasks} open
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">{item.tasks_touched}</td>
                  <td className="px-3 py-2 text-[#4b5563]">{item.completed_tasks}</td>
                  <td className="px-3 py-2 text-[#4b5563]">{item.reviewed_tasks}</td>
                  <td className="px-3 py-2 text-[#4b5563]">{item.approved_tasks}</td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    <div>{formatMinutes(item.average_completion_minutes)}</div>
                    <div className="text-xs text-[#6b7280]">{item.completed_turnaround_count} timed</div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    <div>{formatMinutes(item.active_session_minutes)}</div>
                    <div className="text-xs text-[#6b7280]">Idle {formatMinutes(item.idle_minutes)}</div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">
                    <div>{item.security_events} events</div>
                    <div className={item.high_risk_security_events > 0 ? "text-xs font-medium text-[#b42318]" : "text-xs text-[#6b7280]"}>
                      {item.high_risk_security_events} high risk
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[#4b5563]">{formatDateTime(item.last_activity_at ?? item.last_login_at)}</td>
                </tr>
              ))}
              {(metrics?.user_metrics ?? []).length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-5 text-center text-sm text-[#6b7280]">
                    No user metrics match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <div className="oa-card p-4">
          <h3 className="oa-title mb-3 text-sm font-semibold">Tagger Metrics</h3>
          <div className="overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.08em] text-[#6b7280]">
                <tr>
                  <th className="px-3 py-2">Tagger</th>
                  <th className="px-3 py-2">Touched</th>
                  <th className="px-3 py-2">Completed</th>
                  <th className="px-3 py-2">Reviewed</th>
                  <th className="px-3 py-2">Approved</th>
                  <th className="px-3 py-2">PII</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eef2f7]">
                {(metrics?.tagger_metrics ?? []).map((item, index) => (
                  <tr key={item.user_id ?? item.user_email ?? `tagger-${index}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-[#111827]">
                        {item.user_name ?? item.user_email ?? item.user_id ?? "Deleted user"}
                      </div>
                      {item.user_email && item.user_name ? (
                        <div className="text-xs text-[#6b7280]">{item.user_email}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.tasks_touched} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.completed_tasks} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.reviewed_tasks} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.approved_tasks} format={formatInteger} />
                    </td>
                    <td className="px-3 py-2 text-[#4b5563]">
                      <AnimatedMetricNumber value={item.pii_annotations} format={formatInteger} />
                    </td>
                  </tr>
                ))}
                {metrics?.tagger_metrics.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-5 text-center text-sm text-[#6b7280]">
                      No tagger activity matches these filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="oa-card p-4">
          <h3 className="oa-title mb-3 text-sm font-semibold">Highest WER Tasks</h3>
          <div className="space-y-2">
            {(metrics?.worst_tasks ?? []).slice(0, 8).map((task) => (
              <div key={task.task_id} className="rounded-lg border border-[#e5e7eb] bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link href={`/tasks/${task.task_id}`} className="text-sm font-semibold text-[#2563eb] hover:underline">
                      {task.external_id}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6b7280]">
                      <StatusBadge status={task.status} />
                      <span>{task.language ?? "Language not set"}</span>
                      <span>{task.last_tagger_name ?? "No tagger recorded"}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-[#6b7280]">Max WER</div>
                    <div className="text-lg font-semibold text-[#111827]">
                      <AnimatedMetricNumber value={percentValue(task.max_wer)} format={formatPercentValue} />
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {task.source_metrics.map((source) => (
                    <span
                      key={source.source_key}
                      className="rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-2 py-0.5 text-xs text-[#4b5563]"
                    >
                      {source.source_label}:{" "}
                      <AnimatedMetricNumber value={source.wer} format={formatRateValue} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {metrics?.worst_tasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">
                No scored tasks match these filters.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <SectionHeading
        eyebrow="Configuration"
        title="PII Label Management"
        description="Maintain the labels that appear in annotator and reviewer PII dropdowns."
      />

      <section className="oa-card p-4">
        <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3 className="oa-title text-sm font-semibold">Label Catalog</h3>
            <p className="mt-1 text-xs text-[#6b7280]">
              Active labels appear in the annotator dropdown for taggers.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[150px_180px_90px_minmax(200px,1fr)_auto]">
            <input
              aria-label="New label key"
              value={newLabelKey}
              onChange={(event) => setNewLabelKey(event.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))}
              className="oa-input"
              placeholder="Label key"
            />
            <input
              aria-label="New label name"
              value={newLabelName}
              onChange={(event) => setNewLabelName(event.target.value)}
              className="oa-input"
              placeholder="Display name"
            />
            <input
              aria-label="New label color"
              type="color"
              value={newLabelColor}
              onChange={(event) => setNewLabelColor(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#d1d5db] bg-white px-2"
            />
            <input
              aria-label="New label description"
              value={newLabelDescription}
              onChange={(event) => setNewLabelDescription(event.target.value)}
              className="oa-input"
              placeholder="Optional description"
            />
            <button
              type="button"
              onClick={handleCreateLabel}
              disabled={labelBusy || !newLabelKey.trim() || !newLabelName.trim()}
              className="oa-btn-primary px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add Label
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.08em] text-[#6b7280]">
              <tr>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Display</th>
                <th className="px-3 py-2">Color</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eef2f7]">
              {labels.map((label) => {
                const draft = labelDrafts[label.id] ?? labelDraftFrom(label);
                return (
                  <tr key={label.id}>
                    <td className="px-3 py-2">
                      <span
                        className="rounded-full border px-2 py-0.5 text-xs font-semibold"
                        style={{ borderColor: `${draft.color}55`, color: draft.color, backgroundColor: `${draft.color}14` }}
                      >
                        {label.key}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Display name for ${label.key}`}
                        value={draft.display_name}
                        onChange={(event) =>
                          setLabelDrafts((prev) => ({
                            ...prev,
                            [label.id]: { ...draft, display_name: event.target.value },
                          }))
                        }
                        className="oa-input min-w-[150px] py-1.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Color for ${label.key}`}
                        type="color"
                        value={draft.color}
                        onChange={(event) =>
                          setLabelDrafts((prev) => ({
                            ...prev,
                            [label.id]: { ...draft, color: event.target.value },
                          }))
                        }
                        className="h-9 w-14 rounded-md border border-[#d1d5db] bg-white px-1"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Description for ${label.key}`}
                        value={draft.description}
                        onChange={(event) =>
                          setLabelDrafts((prev) => ({
                            ...prev,
                            [label.id]: { ...draft, description: event.target.value },
                          }))
                        }
                        className="oa-input min-w-[220px] py-1.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Sort order for ${label.key}`}
                        type="number"
                        min={0}
                        value={draft.sort_order}
                        onChange={(event) =>
                          setLabelDrafts((prev) => ({
                            ...prev,
                            [label.id]: { ...draft, sort_order: Number(event.target.value) },
                          }))
                        }
                        className="oa-input w-24 py-1.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Active ${label.key}`}
                        type="checkbox"
                        checked={draft.is_active}
                        onChange={(event) =>
                          setLabelDrafts((prev) => ({
                            ...prev,
                            [label.id]: { ...draft, is_active: event.target.checked },
                          }))
                        }
                        className="h-4 w-4 rounded border-[#d1d5db]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => handleSaveLabel(label)}
                        disabled={labelBusy}
                        className="oa-btn-secondary px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  meta,
}: {
  eyebrow: string;
  title: string;
  description: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-[#e5e7eb] pb-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7c7895]">{eyebrow}</p>
        <h3 className="oa-title text-lg font-semibold">{title}</h3>
        <p className="mt-1 max-w-3xl text-sm text-[#6b7280]">{description}</p>
      </div>
      {meta ? <div className="text-sm text-[#4b5563]">{meta}</div> : null}
    </div>
  );
}

function MetricSummaryCard({
  label,
  value,
  format,
  detail,
  loading = false,
}: {
  label: string;
  value: number | null | undefined;
  format: (value: number) => string;
  detail: string;
  loading?: boolean;
}) {
  return (
    <div className="oa-card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">{label}</div>
      <AnimatedMetricNumber
        loading={loading}
        value={value ?? null}
        format={format}
        className="mt-2 block text-2xl font-semibold text-[#111827]"
      />
      <div className="mt-1 text-xs text-[#6b7280]">{detail}</div>
    </div>
  );
}

function BreakdownCard({
  title,
  items,
  emptyMessage,
  formatValue,
}: {
  title: string;
  items: Array<[string, number]>;
  emptyMessage: string;
  formatValue: (value: number) => string;
}) {
  return (
    <div className="oa-card p-4">
      <h3 className="oa-title mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([label, count]) => (
          <div key={label} className="flex items-center justify-between rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
            <span className="truncate text-sm font-medium text-[#111827]">{label}</span>
            <AnimatedMetricNumber value={count} format={formatValue} className="ml-3 text-sm text-[#4b5563]" />
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[#d1d5db] px-3 py-3 text-sm text-[#6b7280]">{emptyMessage}</p>
      ) : null}
    </div>
  );
}

function BenchmarkTable({
  title,
  rows,
  showGroup = false,
  formatPercentValue,
  percentValue,
}: {
  title: string;
  rows: ModelBenchmarkMetric[];
  showGroup?: boolean;
  formatPercentValue: (value: number) => string;
  percentValue: (value: number | null | undefined) => number | null;
}) {
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-white p-3">
      <h4 className="text-sm font-semibold text-[#111827]">{title}</h4>
      <div className="mt-2 overflow-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="uppercase tracking-[0.08em] text-[#6b7280]">
            <tr>
              <th className="px-2 py-1.5">Rank</th>
              {showGroup ? <th className="px-2 py-1.5">Group</th> : null}
              <th className="px-2 py-1.5">Model</th>
              <th className="px-2 py-1.5">WER</th>
              <th className="px-2 py-1.5">CER</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#eef2f7]">
            {rows.map((row) => (
              <tr key={`${title}-${row.group_key}-${row.source_key}-${row.rank}`}>
                <td className="px-2 py-1.5 text-[#4b5563]">#{row.rank}</td>
                {showGroup ? <td className="px-2 py-1.5 text-[#4b5563]">{row.group_label}</td> : null}
                <td className="px-2 py-1.5 font-medium text-[#111827]">{row.source_label}</td>
                <td className="px-2 py-1.5 text-[#4b5563]">
                  <AnimatedMetricNumber value={percentValue(row.average_wer)} format={formatPercentValue} />
                </td>
                <td className="px-2 py-1.5 text-[#4b5563]">
                  <AnimatedMetricNumber value={percentValue(row.average_cer)} format={formatPercentValue} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={showGroup ? 5 : 4} className="px-2 py-4 text-center text-[#6b7280]">
                  No benchmark data.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import type { HiringAssignmentSummary } from "@outcomes/shared-types";
import Link from "next/link";
import { useEffect, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { useAuth } from "@/components/auth-provider";
import { APIError, fetchCandidateHiringAssignments } from "@/lib/api";

function formatDate(value: string | null) {
  if (!value) return "No due date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function progressLabel(item: HiringAssignmentSummary) {
  if (item.item_count === 0) return "No audio";
  return `${item.submitted_count}/${item.item_count} submitted`;
}

export default function CandidateHiringPage() {
  const { accessToken, activeOrganizationId } = useAuth();
  const [items, setItems] = useState<HiringAssignmentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setError(null);
    void (async () => {
      try {
        const response = await fetchCandidateHiringAssignments(accessToken);
        if (!cancelled) {
          setItems(response.items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Could not load hiring tests");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, activeOrganizationId]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">Hiring Test</p>
          <h1 className="oa-title text-2xl font-semibold">Assigned assessments</h1>
        </div>
      </section>

      {error ? <p className="rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">{error}</p> : null}
      {loading ? <div className="oa-card px-4 py-3 text-sm text-[#5f5b79]">Loading tests...</div> : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/hiring/${item.id}`}
            className="oa-card block p-4 transition hover:-translate-y-0.5 hover:shadow-[0_18px_46px_-32px_rgba(18,13,40,0.75)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="oa-title text-lg font-semibold">{item.assessment_title}</h2>
                <p className="mt-1 text-sm text-[#5f5b79]">{formatDate(item.due_date)}</p>
              </div>
              <span className="oa-chip">{item.status.replaceAll("_", " ")}</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg border border-[#eee5f8] bg-[#fbf8ff] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#7a7395]">Audio</p>
                <p className="mt-1 font-semibold text-[#1f1b3f]">{item.item_count}</p>
              </div>
              <div className="rounded-lg border border-[#eee5f8] bg-[#fbf8ff] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#7a7395]">Progress</p>
                <p className="mt-1 font-semibold text-[#1f1b3f]">{progressLabel(item)}</p>
              </div>
              <div className="rounded-lg border border-[#eee5f8] bg-[#fbf8ff] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#7a7395]">Decision</p>
                <p className="mt-1 font-semibold text-[#1f1b3f]">{item.decision}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {!loading && items.length === 0 ? (
        <div className="oa-card px-4 py-6 text-center text-sm text-[#5f5b79]">No hiring assessments are assigned yet.</div>
      ) : null}
    </div>
  );
}

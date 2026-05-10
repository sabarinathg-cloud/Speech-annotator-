"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { AccountSummary } from "@/components/account-summary";
import { useAuth } from "@/components/auth-provider";
import { SecurityActivityGuard } from "@/components/security-activity-guard";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, accessToken, isLoading, logout, acknowledgeConfidentiality } = useAuth();
  const [ackChecked, setAckChecked] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const isAdminRoute = pathname.startsWith("/admin");
  const shouldRedirectFromAdminRoute = Boolean(
    !isLoading && accessToken && user && user.role !== "ADMIN" && isAdminRoute
  );

  useEffect(() => {
    if (!isLoading && !accessToken) {
      router.replace("/login");
    }
  }, [accessToken, isLoading, router]);

  useEffect(() => {
    if (shouldRedirectFromAdminRoute) {
      router.replace("/tasks");
    }
  }, [router, shouldRedirectFromAdminRoute]);

  if (isLoading || !accessToken) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4">
        <div className="oa-card px-5 py-4 text-sm text-[#5f5b79]">Loading workspace...</div>
      </main>
    );
  }

  if (shouldRedirectFromAdminRoute) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4">
        <div className="oa-card px-5 py-4 text-sm text-[#5f5b79]">Opening assigned work...</div>
      </main>
    );
  }

  const links = [
    { href: "/tasks", label: "Tasks" },
    ...(user?.role === "ADMIN"
      ? [
          { href: "/admin/upload", label: "Admin Upload" },
          { href: "/admin/metrics", label: "Metrics" },
          { href: "/admin/security", label: "Security" },
        ]
      : [])
  ];
  const requiresConfidentialityAck = Boolean(user && user.confidentiality_acknowledged_for_session !== true);

  return (
    <div className="oa-page">
      <SecurityActivityGuard accessToken={accessToken} />
      <div
        aria-label="Confidential workspace watermark"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 border-t border-[#d9d2ef] bg-white/86 px-4 py-1 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4f476e] shadow-[0_-10px_28px_-24px_rgba(15,23,42,0.7)]"
      >
        Confidential workspace | {user?.email ?? "signed-in user"} | {new Date().toLocaleString()}
      </div>
      <header className="sticky top-0 z-30 border-b border-[#e8def5] bg-white/80 backdrop-blur-lg">
        <div className="mx-auto max-w-[1360px] px-4 py-3 sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-4 sm:gap-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7c7895]">Outcomes.ai</p>
                <h1 className="oa-title text-sm font-semibold tracking-[0.01em] sm:text-base">
                  Speech Annotator
                </h1>
              </div>

              <nav className="flex items-center gap-1 rounded-xl border border-[#e5daf4] bg-[#f7f2ff] p-1">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      pathname.startsWith(link.href)
                        ? "border border-[#d3c1ea] bg-white text-[#1e1a3d] shadow-[0_10px_18px_-16px_rgba(22,19,45,0.88)]"
                        : "text-[#645f7d] hover:bg-white"
                    )}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="flex items-center gap-3">
              <AccountSummary user={user} />
              <button
                type="button"
                onClick={() => {
                  logout();
                  router.replace("/login");
                }}
                className="oa-btn-secondary px-3.5 py-2 text-sm font-medium"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      {requiresConfidentialityAck ? (
        <main className="mx-auto flex min-h-[calc(100vh-120px)] max-w-[1360px] items-center justify-center px-4 py-5 sm:px-6">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Confidentiality acknowledgement"
            className="oa-card max-w-xl p-5 sm:p-6"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">Sensitive Data</p>
            <h2 className="oa-title mt-1 text-xl font-semibold">Confidentiality acknowledgement</h2>
            <p className="mt-2 text-sm leading-6 text-[#5f5b79]">
              This workspace contains sensitive call data. Access is for assigned annotation work only.
              Do not copy, download, share, photograph, or discuss customer data outside approved workflows.
            </p>
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-[#e6dcf2] bg-[#fbf8ff] p-3 text-sm text-[#332d53]">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(event) => setAckChecked(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
              />
              <span>I understand and will handle all annotation data only inside the approved workflow.</span>
            </label>
            {ackError ? (
              <p className="mt-3 rounded-lg border border-[#f0c8c8] bg-[#fff3f3] px-3 py-2 text-sm text-[#a13a3a]">
                {ackError}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!ackChecked || ackBusy}
              onClick={async () => {
                setAckBusy(true);
                setAckError(null);
                try {
                  await acknowledgeConfidentiality();
                } catch {
                  setAckError("Could not save acknowledgement. Please try again.");
                } finally {
                  setAckBusy(false);
                }
              }}
              className="oa-btn-primary mt-4 w-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
            >
              {ackBusy ? "Saving..." : "Accept and continue"}
            </button>
          </section>
        </main>
      ) : (
        <main className="mx-auto max-w-[1360px] px-4 py-5 pb-12 sm:px-6">{children}</main>
      )}
    </div>
  );
}

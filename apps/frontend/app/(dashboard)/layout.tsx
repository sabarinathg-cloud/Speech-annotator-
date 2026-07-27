"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import clsx from "clsx";

import { AccountSummary } from "@/components/account-summary";
import { ActivityTracker } from "@/components/activity-tracker";
import { useAuth } from "@/components/auth-provider";
import { SecurityActivityGuard } from "@/components/security-activity-guard";
import { changeOwnPassword } from "@/lib/api";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const {
    user,
    accessToken,
    activeOrganization,
    activeOrganizationId,
    isLoading,
    logout,
    acknowledgeConfidentiality,
    setActiveOrganizationId,
  } = useAuth();
  const [ackChecked, setAckChecked] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const isAdminRoute = pathname.startsWith("/admin");
  const isCandidateRoute = pathname.startsWith("/hiring");
  const requiresConfidentialityAck = Boolean(user && user.confidentiality_acknowledged_for_session !== true);
  const organizationInstructionText = (activeOrganization?.settings.instructions ?? "").trim();
  const organizationInstructionKey =
    activeOrganizationId && organizationInstructionText
      ? organizationInstructionsSeenKey(activeOrganizationId, organizationInstructionText)
      : null;
  const showOrganizationInstructions = Boolean(
    user &&
      (user.role === "ANNOTATOR" || user.role === "REVIEWER") &&
      activeOrganization &&
      organizationInstructionText
  );
  const shouldRedirectFromAdminRoute = Boolean(
    !isLoading && accessToken && user && user.role !== "ADMIN" && isAdminRoute
  );
  const shouldRedirectCandidateToHiring = Boolean(
    !isLoading && accessToken && user?.role === "CANDIDATE" && !isCandidateRoute
  );
  const shouldRedirectNonCandidateFromHiring = Boolean(
    !isLoading && accessToken && user && user.role !== "CANDIDATE" && isCandidateRoute
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

  useEffect(() => {
    if (shouldRedirectCandidateToHiring) {
      router.replace("/hiring");
    }
  }, [router, shouldRedirectCandidateToHiring]);

  useEffect(() => {
    if (shouldRedirectNonCandidateFromHiring) {
      router.replace("/tasks");
    }
  }, [router, shouldRedirectNonCandidateFromHiring]);

  useEffect(() => {
    if (!showOrganizationInstructions || !organizationInstructionKey) {
      setInstructionsOpen(false);
      return;
    }
    if (requiresConfidentialityAck) return;
    if (!hasSeenOrganizationInstructions(organizationInstructionKey)) {
      setInstructionsOpen(true);
    }
  }, [organizationInstructionKey, requiresConfidentialityAck, showOrganizationInstructions]);

  function closeOrganizationInstructions() {
    if (organizationInstructionKey) {
      markOrganizationInstructionsSeen(organizationInstructionKey);
    }
    setInstructionsOpen(false);
  }

  function closePasswordModal() {
    if (passwordBusy) return;
    setPasswordModalOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setPasswordError(null);
    if (newPassword.length < 8 || newPassword.length > 128) {
      setPasswordError("New password must be 8 to 128 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError("New password must be different from your current password.");
      return;
    }

    setPasswordBusy(true);
    try {
      await changeOwnPassword(accessToken, {
        current_password: currentPassword,
        new_password: newPassword,
      });
      logout();
      router.replace("/login?passwordChanged=1");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Could not change password. Please try again.");
    } finally {
      setPasswordBusy(false);
    }
  }

  if (isLoading || !accessToken) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4">
        <div className="oa-card px-5 py-4 text-sm text-[#5f5b79]">Loading workspace...</div>
      </main>
    );
  }

  if (shouldRedirectFromAdminRoute || shouldRedirectCandidateToHiring || shouldRedirectNonCandidateFromHiring) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4">
        <div className="oa-card px-5 py-4 text-sm text-[#5f5b79]">Opening workspace...</div>
      </main>
    );
  }

  const organizationOptions = (user?.organizations ?? []).filter((organization) => organization.is_active);
  const showOrganizationSelector = organizationOptions.length > 1 || user?.role === "ADMIN";
  const orgSettings = activeOrganization?.settings;
  const links =
    user?.role === "CANDIDATE"
      ? [{ href: "/hiring", label: "Hiring Test" }]
      : [
          { href: "/tasks", label: "Tasks" },
          ...(user?.role === "ADMIN"
            ? [
                ...(orgSettings?.hiring_enabled === false ? [] : [{ href: "/admin/hiring", label: "Hiring" }]),
                { href: "/admin/upload", label: "Admin Upload" },
                { href: "/admin/metrics", label: "Metrics" },
                { href: "/admin/security", label: "Security" },
                { href: "/admin/organizations", label: "Organizations" },
              ]
            : [])
        ];
  const strictSecurityGuardEnabled = Boolean(user && user.role !== "ADMIN" && user.role !== "CANDIDATE");
  const confidentialityBody =
    user?.role === "CANDIDATE"
      ? "This hiring workspace contains sensitive assessment audio. Use the in-app player, prepare your answers, and submit them here. Do not share the audio, transcripts, or assessment content outside the approved hiring workflow."
      : user?.role === "ADMIN"
        ? "This workspace contains sensitive call and hiring assessment data. Admin access is for approved setup, review, evaluation, user management, and audit workflows only."
        : "This workspace contains sensitive call data. Access is for assigned annotation work only. Do not copy, share, photograph, or discuss customer data outside approved workflows.";
  const confidentialityConfirmation =
    user?.role === "CANDIDATE"
      ? "I understand and will use the assigned hiring audio only for this assessment."
      : user?.role === "ADMIN"
        ? "I understand and will handle all workspace data only through approved admin workflows."
        : "I understand and will handle all annotation data only inside the approved workflow.";

  return (
    <div className={clsx("oa-page", strictSecurityGuardEnabled && "strict-confidential-workspace")}>
      <SecurityActivityGuard accessToken={accessToken} enabled={strictSecurityGuardEnabled} />
      <ActivityTracker enabled={!requiresConfidentialityAck} />
      {strictSecurityGuardEnabled ? (
        <div className="strict-print-warning" role="note">
          Printing is disabled for this confidential workspace.
        </div>
      ) : null}
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
              {showOrganizationSelector ? (
                <label className="flex min-w-[220px] items-center gap-2 rounded-xl border border-[#e5daf4] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#756d92]">
                  Org
                  <select
                    value={activeOrganizationId ?? ""}
                    onChange={(event) => {
                      if (!event.target.value) return;
                      setActiveOrganizationId(event.target.value);
                      router.refresh();
                    }}
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold normal-case tracking-normal text-[#241f43] outline-none"
                    aria-label="Active organization"
                  >
                    {organizationOptions.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : activeOrganization ? (
                <div className="hidden rounded-xl border border-[#e5daf4] bg-white px-3 py-2 text-sm font-semibold text-[#4f476e] sm:block">
                  {activeOrganization.name}
                </div>
              ) : null}
              {showOrganizationInstructions ? (
                <button
                  type="button"
                  onClick={() => setInstructionsOpen(true)}
                  className="oa-btn-secondary px-3.5 py-2 text-sm font-medium"
                >
                  Instructions
                </button>
              ) : null}
              <AccountSummary user={user} />
              <button
                type="button"
                onClick={() => setPasswordModalOpen(true)}
                className="oa-btn-secondary px-3.5 py-2 text-sm font-medium"
              >
                Change password
              </button>
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

      {passwordModalOpen ? (
        <PasswordChangeDialog
          currentPassword={currentPassword}
          newPassword={newPassword}
          confirmPassword={confirmPassword}
          busy={passwordBusy}
          error={passwordError}
          onCurrentPasswordChange={setCurrentPassword}
          onNewPasswordChange={setNewPassword}
          onConfirmPasswordChange={setConfirmPassword}
          onClose={closePasswordModal}
          onSubmit={handlePasswordChange}
        />
      ) : null}

      {showOrganizationInstructions && instructionsOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#1f1a35]/45 px-4 py-6 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Organization instructions"
            className="oa-card max-h-[86vh] w-full max-w-2xl overflow-hidden p-0"
          >
            <div className="border-b border-[#ece6f5] px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">
                Organization instructions
              </p>
              <h2 className="oa-title mt-1 text-xl font-semibold">{activeOrganization?.name}</h2>
            </div>
            <div className="max-h-[58vh] overflow-auto px-5 py-4">
              <p className="whitespace-pre-wrap text-sm leading-6 text-[#3e385c]">{organizationInstructionText}</p>
            </div>
            <div className="flex flex-col gap-2 border-t border-[#ece6f5] bg-[#fbf8ff] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-[#6f6a86]">
                You can reopen these from the header at any time.
              </p>
              <button
                type="button"
                onClick={closeOrganizationInstructions}
                className="oa-btn-primary px-4 py-2 text-sm font-semibold"
              >
                Got it
              </button>
            </div>
          </section>
        </div>
      ) : null}

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
            <p className="mt-2 text-sm leading-6 text-[#5f5b79]">{confidentialityBody}</p>
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-[#e6dcf2] bg-[#fbf8ff] p-3 text-sm text-[#332d53]">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(event) => setAckChecked(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
              />
              <span>{confidentialityConfirmation}</span>
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

type PasswordChangeDialogProps = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  busy: boolean;
  error: string | null;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function PasswordChangeDialog({
  currentPassword,
  newPassword,
  confirmPassword,
  busy,
  error,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onClose,
  onSubmit,
}: PasswordChangeDialogProps) {
  const lengthValid = newPassword.length >= 8 && newPassword.length <= 128;
  const confirmationMatches = confirmPassword.length > 0 && newPassword === confirmPassword;
  const differentFromCurrent = currentPassword.length > 0 && newPassword !== currentPassword;
  const canSubmit = Boolean(currentPassword) && lengthValid && confirmationMatches && differentFromCurrent && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1f1a35]/45 px-4 py-6 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        className="oa-card w-full max-w-md overflow-hidden p-0"
      >
        <div className="border-b border-[#ece6f5] px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">Account security</p>
          <h2 className="oa-title mt-1 text-xl font-semibold">Change password</h2>
          <p className="mt-1 text-sm leading-5 text-[#6f6a86]">
            You will sign in again after the password is changed.
          </p>
        </div>
        <form className="space-y-4 px-5 py-4" onSubmit={onSubmit}>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6f6a86]">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => onCurrentPasswordChange(event.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-[#ddc9f2] bg-white px-3 text-sm text-[#241f43] outline-none focus:border-[#b57cdf] focus:ring-4 focus:ring-[#d8bbf1]/35"
              required
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6f6a86]">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => onNewPasswordChange(event.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-[#ddc9f2] bg-white px-3 text-sm text-[#241f43] outline-none focus:border-[#b57cdf] focus:ring-4 focus:ring-[#d8bbf1]/35"
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6f6a86]">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => onConfirmPasswordChange(event.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-[#ddc9f2] bg-white px-3 text-sm text-[#241f43] outline-none focus:border-[#b57cdf] focus:ring-4 focus:ring-[#d8bbf1]/35"
              minLength={8}
              maxLength={128}
              required
            />
          </label>

          <div className="rounded-xl border border-[#e8def5] bg-[#fbf8ff] px-3 py-2 text-xs leading-5 text-[#6f6a86]">
            Password must be 8 to 128 characters and different from your current password.
          </div>
          {confirmPassword && !confirmationMatches ? (
            <p className="rounded-lg border border-[#f2d6a4] bg-[#fff8ea] px-3 py-2 text-sm text-[#8a5a11]">
              New password and confirmation do not match.
            </p>
          ) : null}
          {currentPassword && newPassword && !differentFromCurrent ? (
            <p className="rounded-lg border border-[#f2d6a4] bg-[#fff8ea] px-3 py-2 text-sm text-[#8a5a11]">
              New password must be different from your current password.
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2 border-t border-[#ece6f5] pt-4">
            <button type="button" onClick={onClose} disabled={busy} className="oa-btn-secondary px-4 py-2 text-sm font-medium">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="oa-btn-primary px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
            >
              {busy ? "Changing..." : "Change password"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function organizationInstructionsSeenKey(organizationId: string, instructions: string) {
  return `outcomes_ai_org_instructions_seen:${organizationId}:${hashInstructionText(instructions)}`;
}

function hashInstructionText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function hasSeenOrganizationInstructions(key: string) {
  try {
    return window.localStorage.getItem(key) === "seen";
  } catch {
    return false;
  }
}

function markOrganizationInstructionsSeen(key: string) {
  try {
    window.localStorage.setItem(key, "seen");
  } catch {
    // If storage is unavailable, keep the prompt dismissible for this session.
  }
}

"use client";

import type { AdminUser, Organization, OrganizationSettings } from "@outcomes/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  addOrganizationMember,
  createOrganization,
  fetchCurrentUser,
  fetchOrganizationMembers,
  fetchOrganizations,
  fetchUsers,
  removeOrganizationMember,
  updateOrganization,
} from "@/lib/api";
import { readSession, writeSession } from "@/lib/session";

const featureLabels: Array<{ key: keyof OrganizationSettings; label: string; hint: string }> = [
  { key: "metadata_enabled", label: "Metadata", hint: "Show metadata fields and allow metadata import/update." },
  { key: "pii_enabled", label: "PII", hint: "Show PII review, labels, and detection." },
  { key: "transcript_redaction_enabled", label: "Transcript redaction", hint: "Add redacted transcript previews/exports." },
  { key: "audio_masking_enabled", label: "Audio masking", hint: "Allow masked audio generation from PII spans." },
  { key: "hiring_enabled", label: "Hiring", hint: "Show hiring assessments and candidate flows." },
];

const blankCreateForm: Partial<OrganizationSettings> & { name: string; slug: string; is_active: boolean } = {
  name: "",
  slug: "",
  is_active: true,
  metadata_enabled: false,
  pii_enabled: false,
  transcript_redaction_enabled: false,
  audio_masking_enabled: false,
  hiring_enabled: false,
};

export default function AdminOrganizationsPage() {
  const { accessToken, activeOrganizationId, setActiveOrganizationId } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(activeOrganizationId);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof fetchOrganizationMembers>>["items"]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [memberUserId, setMemberUserId] = useState("");
  const [createForm, setCreateForm] = useState(blankCreateForm);
  const [draft, setDraft] = useState<Organization | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedOrgId) ?? organizations[0] ?? null,
    [organizations, selectedOrgId]
  );
  const currentMemberIds = useMemo(() => new Set(members.map((member) => member.user_id)), [members]);
  const addableUsers = useMemo(
    () =>
      users
        .filter((user) => user.role !== "ADMIN")
        .filter((user) => !currentMemberIds.has(user.id))
        .sort((first, second) => first.full_name.localeCompare(second.full_name)),
    [currentMemberIds, users]
  );

  useEffect(() => {
    if (!accessToken) return;
    const token = accessToken;
    let cancelled = false;
    async function load() {
      try {
        const [orgResponse, userResponse] = await Promise.all([
          fetchOrganizations(token),
          fetchUsers(token, { scope: "all" }),
        ]);
        if (cancelled) return;
        setOrganizations(orgResponse.items);
        setUsers(userResponse.items);
        const nextSelected =
          selectedOrgId && orgResponse.items.some((organization) => organization.id === selectedOrgId)
            ? selectedOrgId
            : activeOrganizationId && orgResponse.items.some((organization) => organization.id === activeOrganizationId)
              ? activeOrganizationId
              : orgResponse.items[0]?.id ?? null;
        setSelectedOrgId(nextSelected);
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Could not load organizations");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, activeOrganizationId, selectedOrgId]);

  useEffect(() => {
    setDraft(selectedOrganization ? { ...selectedOrganization } : null);
  }, [selectedOrganization]);

  useEffect(() => {
    if (!accessToken || !selectedOrganization) return;
    const token = accessToken;
    const organizationId = selectedOrganization.id;
    let cancelled = false;
    async function loadMembers() {
      try {
        const response = await fetchOrganizationMembers(token, organizationId);
        if (!cancelled) setMembers(response.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Could not load organization members");
      }
    }
    void loadMembers();
    return () => {
      cancelled = true;
    };
  }, [accessToken, selectedOrganization]);

  async function refreshOrganizations(nextSelectedId?: string) {
    if (!accessToken) return;
    const response = await fetchOrganizations(accessToken);
    setOrganizations(response.items);
    if (nextSelectedId) setSelectedOrgId(nextSelectedId);
  }

  async function handleCreate() {
    if (!accessToken || !createForm.name.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const organization = await createOrganization(accessToken, {
        ...createForm,
        name: createForm.name.trim(),
        slug: createForm.slug.trim() || null,
      });
      setCreateForm(blankCreateForm);
      await refreshOrganizations(organization.id);
      setActiveOrganizationId(organization.id);
      await refreshCurrentUserSession(accessToken);
      setMessage("Organization created.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not create organization");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!accessToken || !draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await updateOrganization(accessToken, draft.id, {
        name: draft.name,
        slug: draft.slug,
        is_active: draft.is_active,
        metadata_enabled: draft.metadata_enabled,
        pii_enabled: draft.pii_enabled,
        transcript_redaction_enabled: draft.transcript_redaction_enabled,
        audio_masking_enabled: draft.audio_masking_enabled,
        hiring_enabled: draft.hiring_enabled,
      });
      setOrganizations((prev) => prev.map((organization) => (organization.id === updated.id ? updated : organization)));
      setDraft(updated);
      await refreshCurrentUserSession(accessToken);
      setMessage("Organization settings saved.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not save organization");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddMember() {
    if (!accessToken || !selectedOrganization || !memberUserId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await addOrganizationMember(accessToken, selectedOrganization.id, memberUserId);
      setMembers(response.items);
      setMemberUserId("");
      setMessage("Member added.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not add member");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!accessToken || !selectedOrganization) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await removeOrganizationMember(accessToken, selectedOrganization.id, userId);
      setMembers(response.items);
      setMessage("Member removed.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not remove member");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="oa-card p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7a7395]">Admin</p>
            <h2 className="oa-title text-2xl font-semibold">Organizations</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#5f5b79]">
              Keep tasks, hiring assessments, metrics, labels, and audit events isolated by organization.
            </p>
          </div>
          <label className="flex min-w-[280px] items-center gap-3 rounded-xl border border-[#e5daf4] bg-[#fbf8ff] px-3 py-2 text-sm font-semibold text-[#5f5b79]">
            Active org
            <select
              value={selectedOrganization?.id ?? ""}
              onChange={(event) => {
                setSelectedOrgId(event.target.value);
                setActiveOrganizationId(event.target.value);
              }}
              className="min-w-0 flex-1 bg-transparent text-[#241f43] outline-none"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error ? <p className="rounded-xl border border-[#f0c8c8] bg-[#fff3f3] px-4 py-3 text-sm text-[#a13a3a]">{error}</p> : null}
      {message ? <p className="rounded-xl border border-[#bee8cc] bg-[#f2fff6] px-4 py-3 text-sm text-[#236140]">{message}</p> : null}

      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <section className="oa-card p-4">
          <h3 className="oa-title text-lg font-semibold">Create organization</h3>
          <div className="mt-4 space-y-3">
            <input
              value={createForm.name}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
              className="oa-input w-full px-3 py-2 text-sm"
              placeholder="Organization name"
            />
            <input
              value={createForm.slug}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, slug: event.target.value }))}
              className="oa-input w-full px-3 py-2 text-sm"
              placeholder="Optional slug"
            />
            <FeatureToggle
              checked={createForm.is_active}
              label="Active"
              onChange={(checked) => setCreateForm((prev) => ({ ...prev, is_active: checked }))}
            />
            {featureLabels.map((feature) => (
              <FeatureToggle
                key={feature.key}
                checked={Boolean(createForm[feature.key])}
                label={feature.label}
                hint={feature.hint}
                onChange={(checked) => setCreateForm((prev) => ({ ...prev, [feature.key]: checked }))}
              />
            ))}
            <button
              type="button"
              disabled={busy || !createForm.name.trim()}
              onClick={() => void handleCreate()}
              className="oa-btn-primary w-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
            >
              Create organization
            </button>
          </div>
        </section>

        <section className="oa-card p-4">
          {draft ? (
            <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
              <div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                    className="oa-input flex-1 px-3 py-2 text-sm"
                    placeholder="Organization name"
                  />
                  <input
                    value={draft.slug}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, slug: event.target.value } : prev))}
                    className="oa-input flex-1 px-3 py-2 text-sm"
                    placeholder="slug"
                  />
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <FeatureToggle
                    checked={draft.is_active}
                    label="Active"
                    onChange={(checked) => setDraft((prev) => (prev ? { ...prev, is_active: checked } : prev))}
                  />
                  {featureLabels.map((feature) => (
                    <FeatureToggle
                      key={feature.key}
                      checked={draft[feature.key]}
                      label={feature.label}
                      hint={feature.hint}
                      onChange={(checked) =>
                        setDraft((prev) => (prev ? { ...prev, [feature.key]: checked } : prev))
                      }
                    />
                  ))}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSave()}
                  className="oa-btn-primary mt-4 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                >
                  Save settings
                </button>
              </div>

              <div className="rounded-xl border border-[#e8def5] bg-[#fbf8ff] p-4">
                <h3 className="oa-title text-lg font-semibold">Members</h3>
                <div className="mt-3 flex gap-2">
                  <select
                    value={memberUserId}
                    onChange={(event) => setMemberUserId(event.target.value)}
                    className="oa-input min-w-0 flex-1 px-3 py-2 text-sm"
                  >
                    <option value="">Add user...</option>
                    {addableUsers.map((availableUser) => (
                      <option key={availableUser.id} value={availableUser.id}>
                        {availableUser.full_name} ({availableUser.role})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !memberUserId}
                    onClick={() => void handleAddMember()}
                    className="oa-btn-secondary px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Add
                  </button>
                </div>
                <div className="mt-4 max-h-[420px] space-y-2 overflow-auto pr-1">
                  {members.length === 0 ? (
                    <p className="rounded-lg bg-white px-3 py-2 text-sm text-[#6b6682]">No members yet.</p>
                  ) : (
                    members.map((member) => (
                      <div key={member.user_id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#241f43]">{member.full_name}</p>
                          <p className="truncate text-xs text-[#6b6682]">{member.email} | {member.role}</p>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveMember(member.user_id)}
                          className="oa-btn-secondary px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[#5f5b79]">Create an organization to start scoping data.</p>
          )}
        </section>
      </div>
    </div>
  );
}

async function refreshCurrentUserSession(accessToken: string) {
  const session = readSession();
  if (!session.refreshToken) return;
  const user = await fetchCurrentUser(accessToken);
  writeSession(accessToken, session.refreshToken, user);
}

function FeatureToggle({
  checked,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-[#e8def5] bg-white p-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
      />
      <span>
        <span className="block font-semibold text-[#241f43]">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-5 text-[#6f6a86]">{hint}</span> : null}
      </span>
    </label>
  );
}

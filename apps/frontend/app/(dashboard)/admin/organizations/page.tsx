"use client";

import type {
  AdminUser,
  Organization,
  OrganizationQuestionnaire,
  OrganizationSettings,
  QuestionnaireFieldType,
  QuestionnaireQuestion,
} from "@outcomes/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import {
  APIError,
  addOrganizationMember,
  createOrganization,
  fetchCurrentUser,
  fetchOrganizationMembers,
  fetchOrganizationQuestionnaire,
  fetchOrganizations,
  fetchUsers,
  removeOrganizationMember,
  saveOrganizationQuestionnaire,
  updateOrganization,
  updateUser,
} from "@/lib/api";
import { readSession, writeSession } from "@/lib/session";

type OrganizationFeatureKey = Exclude<keyof OrganizationSettings, "instructions">;

const defaultOrganizationInstructions = `Please read these instructions before starting annotation work.

- Work only on tasks assigned to you in this organization.
- Listen to the full audio before finalizing transcript changes.
- Correct the transcript exactly as spoken, including punctuation when it is clear.
- Complete metadata or PII fields only when they are enabled for this organization.
- Do not copy, download, screenshot, or share customer audio, transcripts, PII, or metadata outside the approved workspace.
- Contact an admin if audio is missing, unclear, duplicated, or assigned incorrectly.`;

const featureLabels: Array<{ key: OrganizationFeatureKey; label: string; hint: string }> = [
  { key: "metadata_enabled", label: "Metadata", hint: "Show metadata fields and allow metadata import/update." },
  { key: "pii_enabled", label: "PII", hint: "Show PII review, labels, and detection." },
  { key: "transcript_redaction_enabled", label: "Transcript redaction", hint: "Add redacted transcript previews/exports." },
  { key: "audio_masking_enabled", label: "Audio masking", hint: "Allow masked audio generation from PII spans." },
  { key: "hiring_enabled", label: "Hiring", hint: "Show hiring assessments and candidate flows." },
];

const optionalFeatureKeys = featureLabels.map((feature) => feature.key);
const questionnaireFieldTypes: Array<{ value: QuestionnaireFieldType; label: string; needsOptions?: boolean }> = [
  { value: "yes_no", label: "Yes / No" },
  { value: "single_select", label: "Single select", needsOptions: true },
  { value: "multi_select", label: "Multi select", needsOptions: true },
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "rating", label: "Rating" },
  { value: "date", label: "Date" },
];

function createBlankQuestion(sortOrder: number): QuestionnaireQuestion {
  const idSuffix = Math.random().toString(36).slice(2, 8);
  return {
    id: `question_${idSuffix}`,
    label: "",
    field_type: "yes_no",
    help_text: null,
    required: true,
    options: [],
    sort_order: sortOrder,
    scoring_key: null,
  };
}

function emptyQuestionnaire(organizationId: string): OrganizationQuestionnaire {
  return {
    id: null,
    organization_id: organizationId,
    title: "Audio comparison questionnaire",
    description: "Listen to the original and masked audio, then answer these review questions.",
    questions: [
      {
        ...createBlankQuestion(10),
        id: "mask_quality_ok",
        label: "Does the masked audio preserve speech quality?",
        field_type: "yes_no",
      },
      {
        ...createBlankQuestion(20),
        id: "pii_removed",
        label: "Is the sensitive information removed or hidden?",
        field_type: "yes_no",
      },
      {
        ...createBlankQuestion(30),
        id: "review_notes",
        label: "Reviewer notes",
        field_type: "long_text",
        required: false,
      },
    ],
    version: 1,
    is_active: true,
    created_at: null,
    updated_at: null,
  };
}

const blankCreateForm: Partial<OrganizationSettings> & { name: string; slug: string; is_active: boolean } = {
  name: "",
  slug: "",
  is_active: true,
  metadata_enabled: false,
  pii_enabled: false,
  transcript_redaction_enabled: false,
  audio_masking_enabled: false,
  hiring_enabled: false,
  instructions: defaultOrganizationInstructions,
};

export default function AdminOrganizationsPage() {
  const { accessToken, activeOrganizationId, setActiveOrganizationId } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(activeOrganizationId);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof fetchOrganizationMembers>>["items"]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [memberUserId, setMemberUserId] = useState("");
  const [accessUserId, setAccessUserId] = useState("");
  const [accessOrgIds, setAccessOrgIds] = useState<string[]>([]);
  const [createForm, setCreateForm] = useState(blankCreateForm);
  const [draft, setDraft] = useState<Organization | null>(null);
  const [questionnaireDraft, setQuestionnaireDraft] = useState<OrganizationQuestionnaire | null>(null);
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
  const accessUsers = useMemo(
    () =>
      users
        .filter((availableUser) => availableUser.role !== "ADMIN")
        .sort((first, second) => first.full_name.localeCompare(second.full_name)),
    [users]
  );
  const selectedAccessUser = useMemo(
    () => users.find((availableUser) => availableUser.id === accessUserId) ?? null,
    [accessUserId, users]
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

  useEffect(() => {
    if (!accessToken || !selectedOrganization) {
      setQuestionnaireDraft(null);
      return;
    }
    const token = accessToken;
    const organizationId = selectedOrganization.id;
    let cancelled = false;
    async function loadQuestionnaire() {
      try {
        const questionnaire = await fetchOrganizationQuestionnaire(token, organizationId);
        if (cancelled) return;
        setQuestionnaireDraft(
          questionnaire.id || questionnaire.questions.length > 0
            ? questionnaire
            : emptyQuestionnaire(organizationId)
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof APIError ? err.message : "Could not load questionnaire");
      }
    }
    void loadQuestionnaire();
    return () => {
      cancelled = true;
    };
  }, [accessToken, selectedOrganization]);

  useEffect(() => {
    if (accessUserId || accessUsers.length === 0) return;
    setAccessUserId(accessUsers[0].id);
  }, [accessUserId, accessUsers]);

  useEffect(() => {
    if (!selectedAccessUser) {
      setAccessOrgIds([]);
      return;
    }
    setAccessOrgIds((selectedAccessUser.organizations ?? []).map((organization) => organization.id));
  }, [selectedAccessUser]);

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
        instructions: createForm.instructions?.trim() || null,
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
        instructions: draft.instructions?.trim() || null,
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

  function toggleAccessOrg(organizationId: string, checked: boolean) {
    setAccessOrgIds((current) => {
      if (checked) {
        return current.includes(organizationId) ? current : [...current, organizationId];
      }
      return current.filter((id) => id !== organizationId);
    });
  }

  async function handleSaveUserAccess() {
    if (!accessToken || !selectedAccessUser) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updatedUser = await updateUser(accessToken, selectedAccessUser.id, {
        organization_ids: accessOrgIds,
      });
      setUsers((current) => current.map((availableUser) => (availableUser.id === updatedUser.id ? updatedUser : availableUser)));
      if (selectedOrganization) {
        const response = await fetchOrganizationMembers(accessToken, selectedOrganization.id);
        setMembers(response.items);
      }
      setMessage("User organization access saved.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not save user organization access");
    } finally {
      setBusy(false);
    }
  }

  function updateQuestion(index: number, patch: Partial<QuestionnaireQuestion>) {
    setQuestionnaireDraft((current) => {
      if (!current) return current;
      const questions = current.questions.map((question, questionIndex) =>
        questionIndex === index ? { ...question, ...patch } : question
      );
      return { ...current, questions };
    });
  }

  function updateQuestionOptions(index: number, rawValue: string) {
    updateQuestion(index, {
      options: rawValue
        .split("\n")
        .map((option) => option.trim())
        .filter(Boolean),
    });
  }

  function addQuestion() {
    setQuestionnaireDraft((current) => {
      if (!current) return current;
      const nextOrder = (current.questions.at(-1)?.sort_order ?? current.questions.length * 10) + 10;
      return { ...current, questions: [...current.questions, createBlankQuestion(nextOrder)] };
    });
  }

  function removeQuestion(index: number) {
    setQuestionnaireDraft((current) => {
      if (!current) return current;
      return { ...current, questions: current.questions.filter((_, questionIndex) => questionIndex !== index) };
    });
  }

  async function handleSaveQuestionnaire() {
    if (!accessToken || !selectedOrganization || !questionnaireDraft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveOrganizationQuestionnaire(accessToken, selectedOrganization.id, {
        title: questionnaireDraft.title.trim() || "Audio comparison questionnaire",
        description: questionnaireDraft.description?.trim() || null,
        is_active: questionnaireDraft.is_active,
        questions: questionnaireDraft.questions.map((question, index) => ({
          ...question,
          id: question.id.trim(),
          label: question.label.trim(),
          help_text: question.help_text?.trim() || null,
          scoring_key: question.scoring_key?.trim() || null,
          sort_order: question.sort_order || (index + 1) * 10,
        })),
      });
      setQuestionnaireDraft(saved);
      setMessage("Questionnaire saved.");
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Could not save questionnaire");
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
          <p className="mt-1 text-sm text-[#6f6a86]">
            Transcript correction is always enabled. Leave add-ons off for a transcript-only workspace.
          </p>
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
            <CoreWorkflowCard />
            <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
              Instructions for annotators
              <textarea
                value={createForm.instructions ?? ""}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, instructions: event.target.value }))}
                className="oa-textarea mt-1 min-h-[150px] resize-y normal-case tracking-normal"
                placeholder="Shown to annotators when they open this organization. Leave blank to hide."
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCreateForm((prev) => ({ ...prev, instructions: defaultOrganizationInstructions }))}
                className="oa-btn-secondary px-3 py-2 text-sm font-semibold"
              >
                Use default
              </button>
              <button
                type="button"
                onClick={() => setCreateForm((prev) => ({ ...prev, instructions: "" }))}
                className="oa-btn-secondary px-3 py-2 text-sm font-semibold"
              >
                Clear
              </button>
            </div>
            <button
              type="button"
              onClick={() =>
                setCreateForm((prev) => ({
                  ...prev,
                  ...Object.fromEntries(optionalFeatureKeys.map((key) => [key, false])),
                }))
              }
              className="oa-btn-secondary w-full px-3 py-2 text-sm font-semibold"
            >
              Use transcript correction only
            </button>
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
            <div className="space-y-5">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
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
                <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#e8def5] bg-[#fbf8ff] p-3 sm:flex-row sm:items-center sm:justify-between">
                  <CoreWorkflowCard compact />
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              ...Object.fromEntries(optionalFeatureKeys.map((key) => [key, false])),
                            }
                          : prev
                      )
                    }
                    className="oa-btn-secondary shrink-0 px-3 py-2 text-sm font-semibold"
                  >
                    Set transcript only
                  </button>
                </div>
                <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                  Instructions for annotators
                  <textarea
                    value={draft.instructions ?? ""}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, instructions: event.target.value } : prev))}
                    className="oa-textarea mt-1 min-h-[160px] resize-y normal-case tracking-normal"
                    placeholder="Shown to annotators when they open this organization. Leave blank to hide."
                  />
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((prev) => (prev ? { ...prev, instructions: defaultOrganizationInstructions } : prev))
                    }
                    className="oa-btn-secondary px-3 py-2 text-sm font-semibold"
                  >
                    Use default
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => (prev ? { ...prev, instructions: "" } : prev))}
                    className="oa-btn-secondary px-3 py-2 text-sm font-semibold"
                  >
                    Clear instructions
                  </button>
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

              {questionnaireDraft ? (
                <section className="rounded-2xl border border-[#e4d8f2] bg-[#fbf8ff] p-4 shadow-[0_14px_40px_rgba(49,36,77,0.06)]">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="oa-title text-lg font-semibold">Audio comparison questionnaire</h3>
                        <span className="rounded-full border border-[#d8c9ee] bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#62577e]">
                          {questionnaireDraft.questions.length} question
                          {questionnaireDraft.questions.length === 1 ? "" : "s"}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${
                            questionnaireDraft.is_active
                              ? "border-[#bde4ca] bg-[#effaf2] text-[#236140]"
                              : "border-[#efd0d0] bg-[#fff5f5] text-[#9f3b3b]"
                          }`}
                        >
                          {questionnaireDraft.is_active ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-[#6f6a86]">
                        Configure the form annotators answer after listening to original and masked audio.
                      </p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 rounded-xl border border-[#ded1f1] bg-white px-3 py-2 text-sm font-semibold text-[#2a2546]">
                      <input
                        type="checkbox"
                        checked={questionnaireDraft.is_active}
                        onChange={(event) =>
                          setQuestionnaireDraft((current) =>
                            current ? { ...current, is_active: event.target.checked } : current
                          )
                        }
                        className="h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
                      />
                      Active
                    </label>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,360px)_1fr]">
                    <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                      Questionnaire title
                      <input
                        value={questionnaireDraft.title}
                        onChange={(event) =>
                          setQuestionnaireDraft((current) =>
                            current ? { ...current, title: event.target.value } : current
                          )
                        }
                        className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                        placeholder="Audio comparison questionnaire"
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                      Description
                      <input
                        value={questionnaireDraft.description ?? ""}
                        onChange={(event) =>
                          setQuestionnaireDraft((current) =>
                            current ? { ...current, description: event.target.value } : current
                          )
                        }
                        className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                        placeholder="Briefly describe what reviewers should compare."
                      />
                    </label>
                  </div>

                  <div className="mt-4 space-y-3">
                    {questionnaireDraft.questions.map((question, index) => {
                      const typeMeta = questionnaireFieldTypes.find((item) => item.value === question.field_type);
                      return (
                        <article
                          key={`${question.id}-${index}`}
                          className="rounded-2xl border border-[#e5daf4] bg-white p-4 shadow-[0_8px_24px_rgba(49,36,77,0.04)]"
                        >
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-[#f3ecff] px-3 py-1 text-xs font-semibold text-[#5b3f90]">
                                Question {index + 1}
                              </span>
                              <select
                                value={question.field_type}
                                onChange={(event) => {
                                  const fieldType = event.target.value as QuestionnaireFieldType;
                                  const needsOptions = questionnaireFieldTypes.find((item) => item.value === fieldType)?.needsOptions;
                                  updateQuestion(index, {
                                    field_type: fieldType,
                                    options: needsOptions ? question.options : [],
                                  });
                                }}
                                className="oa-input min-w-[190px] px-3 py-2 text-sm"
                              >
                                {questionnaireFieldTypes.map((fieldType) => (
                                  <option key={fieldType.value} value={fieldType.value}>
                                    {fieldType.label}
                                  </option>
                                ))}
                              </select>
                              <label className="flex items-center gap-2 rounded-lg border border-[#e8def5] px-3 py-2 text-sm font-semibold text-[#403c5d]">
                                <input
                                  type="checkbox"
                                  checked={question.required}
                                  onChange={(event) => updateQuestion(index, { required: event.target.checked })}
                                  className="h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
                                />
                                Required
                              </label>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeQuestion(index)}
                              className="oa-btn-secondary px-3 py-2 text-sm font-semibold"
                            >
                              Remove
                            </button>
                          </div>

                          <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(220px,0.65fr)]">
                            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                              Question text
                              <input
                                value={question.label}
                                onChange={(event) => updateQuestion(index, { label: event.target.value })}
                                className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                                placeholder="What should the annotator answer?"
                              />
                            </label>
                            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                              Internal key
                              <input
                                value={question.id}
                                onChange={(event) => updateQuestion(index, { id: event.target.value })}
                                className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                                placeholder="question_id"
                              />
                            </label>
                          </div>

                          <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(200px,260px)]">
                            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                              Help text
                              <input
                                value={question.help_text ?? ""}
                                onChange={(event) => updateQuestion(index, { help_text: event.target.value })}
                                className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                                placeholder="Optional guidance shown below this question."
                              />
                            </label>
                            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                              Scoring key
                              <input
                                value={question.scoring_key ?? ""}
                                onChange={(event) => updateQuestion(index, { scoring_key: event.target.value })}
                                className="oa-input px-3 py-2.5 text-sm normal-case tracking-normal"
                                placeholder="Optional admin score key"
                              />
                            </label>
                          </div>

                          {typeMeta?.needsOptions ? (
                            <label className="mt-3 flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
                              Options
                              <textarea
                                value={question.options.join("\n")}
                                onChange={(event) => updateQuestionOptions(index, event.target.value)}
                                className="oa-textarea min-h-[96px] resize-y text-sm normal-case tracking-normal"
                                placeholder="One option per line"
                              />
                            </label>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>

                  <div className="mt-4 flex flex-col gap-3 border-t border-[#eadff6] pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <button type="button" onClick={addQuestion} className="oa-btn-secondary px-4 py-2 text-sm font-semibold">
                      Add question
                    </button>
                    <button
                      type="button"
                      disabled={busy || questionnaireDraft.questions.length === 0}
                      onClick={() => void handleSaveQuestionnaire()}
                      className="oa-btn-primary px-5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      Save questionnaire
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-[#5f5b79]">Create an organization to start scoping data.</p>
          )}
        </section>
      </div>

      <section className="oa-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="oa-title text-lg font-semibold">User access</h3>
            <p className="mt-1 max-w-3xl text-sm text-[#6f6a86]">
              Add the same annotator, reviewer, or candidate to multiple organizations in one save.
            </p>
          </div>
          <label className="flex min-w-[280px] flex-col gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a6287]">
            User
            <select
              value={accessUserId}
              onChange={(event) => setAccessUserId(event.target.value)}
              className="oa-input px-3 py-2 text-sm normal-case tracking-normal"
            >
              {accessUsers.map((availableUser) => (
                <option key={availableUser.id} value={availableUser.id}>
                  {availableUser.full_name} ({availableUser.role})
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedAccessUser ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {organizations.map((organization) => {
                const checked = accessOrgIds.includes(organization.id);
                return (
                  <label
                    key={organization.id}
                    className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${
                      checked ? "border-[#cdb9ef] bg-[#fbf8ff]" : "border-[#ece6f5] bg-white"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggleAccessOrg(organization.id, event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-[#cfc3e5] text-[#241f43]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-[#241f43]">{organization.name}</span>
                      <span className="mt-0.5 block text-xs text-[#6f6a86]">
                        {organization.is_active ? "Active" : "Inactive"} | {organization.slug}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="rounded-xl border border-[#e8def5] bg-[#fbf8ff] p-3 lg:w-[260px]">
              <p className="text-sm font-semibold text-[#241f43]">{selectedAccessUser.full_name}</p>
              <p className="mt-0.5 truncate text-xs text-[#6f6a86]">{selectedAccessUser.email}</p>
              <p className="mt-3 text-sm text-[#403c5d]">
                {accessOrgIds.length} organization{accessOrgIds.length === 1 ? "" : "s"} selected.
              </p>
              <button
                type="button"
                disabled={busy || accessOrgIds.length === 0}
                onClick={() => void handleSaveUserAccess()}
                className="oa-btn-primary mt-3 w-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
              >
                Save access
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-xl border border-[#e8def5] bg-[#fbf8ff] px-4 py-3 text-sm text-[#6f6a86]">
            Create a non-admin user before assigning organization access.
          </p>
        )}
      </section>
    </div>
  );
}

async function refreshCurrentUserSession(accessToken: string) {
  const session = readSession();
  if (!session.refreshToken) return;
  const user = await fetchCurrentUser(accessToken);
  writeSession(accessToken, session.refreshToken, user);
}

function CoreWorkflowCard({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? "flex min-w-0 flex-1 items-start gap-3"
          : "flex items-start gap-3 rounded-xl border border-[#cdebd7] bg-[#f4fff7] p-3 text-sm"
      }
    >
      <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-[#47a064] bg-[#47a064]" />
      <span className="min-w-0">
        <span className="block font-semibold text-[#241f43]">Transcript correction</span>
        <span className="mt-0.5 block text-xs leading-5 text-[#4e765b]">
          Core workflow, always enabled. Use this alone when an org only needs transcript correction.
        </span>
      </span>
    </div>
  );
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

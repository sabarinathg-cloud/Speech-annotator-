import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TaskWorkspacePage from "@/app/(dashboard)/tasks/[taskId]/page";
import { ANNOTATOR_GUIDED_TOUR_STORAGE_KEY } from "@/components/annotator-guided-tour";

const draftKey = "outcomes-ai:speech-annotator:draft:annotator-1:task-1";
const invalidTranscriptMessage =
  "Invalid characters in transcript: only letters, numbers, spaces, line breaks and . , ? ! - @ are allowed.";

function createDeferred<T>(promiseValue: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, promiseValue, resolve, reject };
}

const {
  push,
  authState,
  searchParamsState,
  fetchTask,
  fetchAudioURL,
  fetchPIILabels,
  fetchTaskActivity,
  detectTaskPII,
  generateTaskAlignment,
  maskTaskPIIAudio,
  patchTaskCombined,
  startTask,
} = vi.hoisted(
  () => ({
    push: vi.fn(),
    authState: {
      user: {
        id: "annotator-1",
        email: "annotator@test.com",
        full_name: "Annotator",
        role: "ANNOTATOR",
      },
    },
    searchParamsState: {
      current: "",
    },
    fetchTask: vi.fn(),
    fetchAudioURL: vi.fn(),
    fetchPIILabels: vi.fn(),
    fetchTaskActivity: vi.fn(),
    detectTaskPII: vi.fn(),
    generateTaskAlignment: vi.fn(),
    maskTaskPIIAudio: vi.fn(),
    patchTaskCombined: vi.fn(),
    startTask: vi.fn()
  })
);

const mockTask = {
  id: "task-1",
  external_id: "OUT-001",
  file_location: "local:///tmp/audio.mp3",
  final_transcript: "",
  notes: "",
  status: "Not Started",
  speaker_gender: "female",
  speaker_role: "caller",
  language: "en",
  channel: "mono",
  duration_seconds: 12.4,
  custom_metadata: { custom_tag: "A1" },
  original_row: {},
  assignee_id: null,
  assignee_name: null,
  assignee_email: null,
  last_tagger_id: null,
  last_tagger_name: null,
  last_tagger_email: null,
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_saved_at: new Date().toISOString(),
  due_date: null,
  alignment_words: [],
  alignment_model: null,
  alignment_updated_at: null,
  masked_audio_available: false,
  masked_audio_updated_at: null,
  masked_audio_intervals: [],
  masked_audio_reference_intervals: [],
  masked_audio_alignment_intervals: [],
  masked_audio_mode: null,
  transcript_variants: [
    {
      id: "tv-1",
      source_key: "whisper",
      source_label: "Whisper",
      transcript_text: "hello world"
    }
  ],
  pii_annotations: [],
  prev_task_id: null,
  next_task_id: null
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: push }),
  useParams: () => ({ taskId: "task-1" }),
  useSearchParams: () => new URLSearchParams(searchParamsState.current),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    accessToken: "test-token",
    user: authState.user,
  })
}));

vi.mock("@/lib/api", () => ({
  APIError: class APIError extends Error {
    status: number;
    payload: unknown;
    constructor(message: string, status: number, payload: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  },
  fetchTask: (...args: unknown[]) => fetchTask(...args),
  fetchAudioURL: (...args: unknown[]) => fetchAudioURL(...args),
  fetchPIILabels: (...args: unknown[]) => fetchPIILabels(...args),
  fetchTaskActivity: (...args: unknown[]) => fetchTaskActivity(...args),
  detectTaskPII: (...args: unknown[]) => detectTaskPII(...args),
  generateTaskAlignment: (...args: unknown[]) => generateTaskAlignment(...args),
  maskTaskPIIAudio: (...args: unknown[]) => maskTaskPIIAudio(...args),
  patchTaskCombined: (...args: unknown[]) => patchTaskCombined(...args),
  startTask: (...args: unknown[]) => startTask(...args)
}));

describe("TaskWorkspacePage", () => {
  beforeEach(() => {
    authState.user = {
      id: "annotator-1",
      email: "annotator@test.com",
      full_name: "Annotator",
      role: "ANNOTATOR",
    };
    searchParamsState.current = "";
    localStorage.removeItem(draftKey);
    localStorage.setItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY, "complete");
    vi.useRealTimers();
    fetchTask.mockResolvedValue(mockTask);
    fetchAudioURL.mockResolvedValue({ url: "/api/v1/media/audio/token", expires_in_seconds: 300 });
    fetchPIILabels.mockResolvedValue({ items: [] });
    fetchTaskActivity.mockResolvedValue({ items: [] });
    detectTaskPII.mockResolvedValue({ pii_annotations: [] });
    generateTaskAlignment.mockResolvedValue({
      task_id: "task-1",
      transcript_hash: "hash",
      model: "test-aligner",
      generated_at: new Date().toISOString(),
      words: [
        {
          index: 0,
          text: "hello",
          normalized_text: "HELLO",
          start_char: 0,
          end_char: 5,
          start_seconds: 0,
          end_seconds: 0.4,
          score: 0.95,
        },
      ],
    });
    maskTaskPIIAudio.mockResolvedValue({
      task_id: "task-1",
      masked_audio_url: "/api/v1/media/audio/masked-token",
      mask_mode: "silence",
      expires_in_seconds: 300,
      generated_at: new Date().toISOString(),
      masked_intervals: [{ start_seconds: 0, end_seconds: 0.4, labels: ["PHONE"], text: "1234567890" }],
      accepted_intervals: [{ start_seconds: 0, end_seconds: 0.4, labels: ["PHONE"], text: "1234567890" }],
      alignment_intervals: [{ start_seconds: 0, end_seconds: 0.4, labels: ["PHONE"], text: "1234567890" }],
      words: [],
    });
    patchTaskCombined.mockResolvedValue({ task: { ...mockTask, version: 2 } });
    startTask.mockResolvedValue({
      task: {
        ...mockTask,
        status: "In Progress",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        version: 2,
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(draftKey);
    localStorage.removeItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("autosaves transcript edits after debounce", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Corrected transcript" }
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await waitFor(() => expect(patchTaskCombined).toHaveBeenCalled(), { timeout: 3500 });
  });

  it("automatically starts not-started tasks when the annotator opens the workspace", async () => {
    render(<TaskWorkspacePage />);

    await waitFor(() => expect(startTask).toHaveBeenCalledWith("test-token", "task-1"));
    expect(await screen.findByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Assignee: Annotator")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("blocks invalid transcript characters before saving", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Hello (test)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Transcript" }));

    expect(await screen.findAllByText(invalidTranscriptMessage)).toHaveLength(2);
    expect(screen.getByLabelText("Autosave section status")).toHaveTextContent("Invalid characters in transcript");
    expect(patchTaskCombined).not.toHaveBeenCalled();
  });

  it("opens an annotator guided tour and walks through PII review to completion guidance", async () => {
    fetchTask.mockResolvedValueOnce({
      ...mockTask,
      status: "Completed",
      final_transcript: "Corrected transcript with no PII for the walkthrough",
      version: 3,
    });
    render(<TaskWorkspacePage />);

    await screen.findByText("Task OUT-001");
    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));
    const dialog = await screen.findByRole("dialog", { name: "Annotator guided tour" });

    expect(within(dialog).getByRole("button", { name: "Full workflow tour" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(dialog).getByRole("button", { name: "Quick tour" })).toBeInTheDocument();
    expect(within(dialog).getByText("Workflow checklist")).toBeInTheDocument();
    expect(within(dialog).getByText("Step 1 of 22")).toBeInTheDocument();
    expect(within(dialog).getByText("Start with the assignment")).toBeInTheDocument();

    for (let index = 0; index < 13; index += 1) {
      if (within(dialog).queryByText("Detect and review PII")) break;
      fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));
    }

    expect(within(dialog).getByText("Detect and review PII")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Detect/ })).toBeInTheDocument();

    for (let index = 0; index < 12; index += 1) {
      if (within(dialog).queryByText("Complete the task")) break;
      fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));
    }

    expect(within(dialog).getByText("Complete the task")).toBeInTheDocument();
    expect(within(dialog).getByText(/move the task to Completed/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Complete task" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Annotator guided tour" })).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY)).toBe("complete");
  });

  it("lets annotators reopen the guided tour from the workspace", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.queryByRole("dialog", { name: "Annotator guided tour" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));

    expect(await screen.findByRole("dialog", { name: "Annotator guided tour" })).toBeInTheDocument();
    expect(screen.getByText("Start with the assignment")).toBeInTheDocument();
  });

  it("keeps the tour closed until clicked, then holds transcript correction until edited", async () => {
    localStorage.removeItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY);

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.queryByRole("dialog", { name: "Annotator guided tour" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));
    const dialog = await screen.findByRole("dialog", { name: "Annotator guided tour" });

    for (let index = 0; index < 12; index += 1) {
      if (within(dialog).queryByText("Correct the final transcript")) break;
      fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));
    }

    expect(within(dialog).getByText("Correct the final transcript")).toBeInTheDocument();
    expect(within(dialog).getByText("Complete this step to continue")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Next step" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Corrected transcript for tour validation" },
    });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Next step" })).toBeEnabled());
    expect(within(dialog).getByText("Ready")).toBeInTheDocument();
  });

  it("force-opens the guided tour from the queue link even after completion", async () => {
    searchParamsState.current = "tour=1";
    localStorage.setItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY, "complete");

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(await screen.findByRole("dialog", { name: "Annotator guided tour" })).toBeInTheDocument();
    expect(screen.getByText("Start with the assignment")).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/tasks/task-1");
  });

  it("requires all sections to be saved before completing and opening the next task", async () => {
    const taskWithNext = { ...mockTask, next_task_id: "task-2" };
    fetchTask.mockResolvedValueOnce(taskWithNext);
    startTask.mockResolvedValueOnce({
      task: {
        ...taskWithNext,
        status: "In Progress",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        version: 2,
      },
    });
    patchTaskCombined.mockResolvedValueOnce({
      task: {
        ...taskWithNext,
        status: "Completed",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        version: 3,
      },
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.queryByText("Inline PII Label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and Next" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Save PII" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Audio Masking" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Metadata" }));

    const saveAndNext = await screen.findByRole("button", { name: "Save and Next" });
    fireEvent.click(saveAndNext);

    await waitFor(() =>
      expect(patchTaskCombined).toHaveBeenCalledWith(
        "test-token",
        "task-1",
        expect.objectContaining({ status: "Completed" })
      )
    );
    expect(push).toHaveBeenCalledWith("/tasks/task-2");
  });

  it("shows completed tasks as already section-saved without duplicate green autosave tiles", async () => {
    fetchTask.mockResolvedValueOnce({
      ...mockTask,
      status: "Completed",
      pii_annotations: [
        {
          id: "pii-address",
          label: "ADDRESS",
          start: 10,
          end: 24,
          value: "Market Street",
          source: "manual",
          confidence: null,
        },
      ],
      masked_audio_intervals: [{ start_seconds: 2.71, end_seconds: 3.75, labels: ["ADDRESS"], text: "Market Street" }],
      masked_audio_reference_intervals: [{ start_seconds: 2.71, end_seconds: 3.75, labels: ["ADDRESS"], text: "Market Street" }],
      masked_audio_alignment_intervals: [{ start_seconds: 2.71, end_seconds: 3.79, labels: ["ADDRESS"], text: "Market Street" }],
      masked_audio_mode: "silence",
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.getByRole("button", { name: "Transcript Saved" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PII Saved" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audio Masking Saved" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Metadata Saved" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Transcript" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Autosave section status")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Changed completed task transcript" },
    });

    expect(screen.getByRole("button", { name: "Save Transcript" })).toBeInTheDocument();
    expect(screen.getByLabelText("Autosave section status")).toHaveTextContent("Pending");
  });

  it("watermarks sensitive task work with the signed-in user and task identifier", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.getByLabelText("Confidential task watermark")).toHaveTextContent("annotator@test.com");
    expect(screen.getByLabelText("Confidential task watermark")).toHaveTextContent("OUT-001");
  });

  it("refreshes task details from successful save responses", async () => {
    patchTaskCombined.mockResolvedValueOnce({
      task: {
        ...mockTask,
        final_transcript: "Corrected transcript",
        assignee_id: "reviewer-1",
        assignee_name: "Reviewer One",
        assignee_email: "reviewer.one@test.com",
        version: 2,
      },
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Corrected transcript" },
    });

    await waitFor(() => expect(patchTaskCombined).toHaveBeenCalled(), { timeout: 3500 });
    await waitFor(() => expect(screen.getByText("Assignee: Reviewer One")).toBeInTheDocument());
  });

  it("restores matching local drafts to avoid data loss after refresh", async () => {
    localStorage.setItem(
      draftKey,
      JSON.stringify({
        schema_version: 1,
        task_id: "task-1",
        user_id: null,
        base_version: 1,
        base_updated_at: mockTask.updated_at,
        saved_at: new Date().toISOString(),
        final_transcript: "Recovered transcript from local draft",
        notes: "Recovered note",
        status: "In Progress",
        metadata: {
          speaker_gender: "female",
          speaker_role: "agent",
          language: "en",
          channel: "mono",
          duration_seconds: "12.4"
        },
        custom_metadata: {
          custom_tag: "drafted"
        }
      })
    );

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.getByDisplayValue("Recovered transcript from local draft")).toBeInTheDocument();
    expect(screen.getByText(/Recovered unsaved draft/i)).toBeInTheDocument();
  });

  it("retries autosave after transient failures", async () => {
    patchTaskCombined.mockReset();
    patchTaskCombined
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue({ task: { ...mockTask, version: 2 } });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Retry this save" }
    });

    await act(async () => {
      vi.advanceTimersByTime(1700);
      await Promise.resolve();
    });

    expect(patchTaskCombined).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Retrying in/i)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2200);
      await Promise.resolve();
    });

    expect(patchTaskCombined).toHaveBeenCalledTimes(2);
  }, 10000);

  it("shows which workspace section failed to autosave", async () => {
    patchTaskCombined.mockReset();
    patchTaskCombined.mockRejectedValueOnce(new Error("network error"));

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Failed transcript save" }
    });

    await act(async () => {
      vi.advanceTimersByTime(1700);
      await Promise.resolve();
    });

    const autosaveStatus = screen.getByLabelText("Autosave section status");
    expect(autosaveStatus).toHaveTextContent("Transcript");
    expect(autosaveStatus).toHaveTextContent("Failed");
    expect(autosaveStatus).toHaveTextContent("Save failed");
  }, 10000);

  it("adds pii label from transcript selection with the keyboard shortcut", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my phone 1234567890" } });

    act(() => {
      textarea.setSelectionRange(9, 19);
      fireEvent.select(textarea);
    });

    fireEvent.keyDown(textarea, { key: "m", altKey: true });

    expect(screen.getByDisplayValue("1234567890")).toBeInTheDocument();
  });

  it("adds pii from the transcript selection with the keyboard shortcut", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "call me at 1234567890" } });

    act(() => {
      textarea.setSelectionRange(11, 21);
      fireEvent.select(textarea);
    });

    fireEvent.keyDown(textarea, { key: "m", altKey: true });

    expect(screen.getByDisplayValue("1234567890")).toBeInTheDocument();
  });

  it("runs all PII models automatically when the PII tab opens", async () => {
    const detectionDeferred = createDeferred({
      pii_annotations: [
        {
          id: "auto-account",
          label: "ACCOUNT_NUMBER",
          start: 8,
          end: 12,
          value: "4829",
          source: "regex",
          confidence: 0.9,
        },
      ],
    });
    detectTaskPII.mockReturnValueOnce(detectionDeferred.promise);

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Account 4829 should be masked" },
    });
    fireEvent.click(screen.getByRole("button", { name: "PII" }));

    expect(await screen.findByText("Scanning transcript with all PII models...")).toBeInTheDocument();
    await waitFor(() =>
      expect(detectTaskPII).toHaveBeenCalledWith("test-token", "Account 4829 should be masked", true)
    );
    expect(screen.getByDisplayValue("4829")).toBeInTheDocument();

    await act(async () => {
      detectionDeferred.resolve(detectionDeferred.promiseValue);
      await Promise.resolve();
    });

    expect(await screen.findByDisplayValue("4829")).toBeInTheDocument();
  });

  it("updates the PII panel with server-only ML detections after the scan completes", async () => {
    const detectionDeferred = createDeferred({
      pii_annotations: [
        {
          id: "ml-person",
          label: "PERSON",
          start: 0,
          end: 5,
          value: "Maria",
          source: "gliner",
          confidence: 0.91,
        },
      ],
    });
    detectTaskPII.mockReturnValueOnce(detectionDeferred.promise);

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "Maria visited Madrid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "PII" }));

    expect(await screen.findByText("Scanning transcript with all PII models...")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Maria")).not.toBeInTheDocument();

    await act(async () => {
      detectionDeferred.resolve(detectionDeferred.promiseValue);
      await Promise.resolve();
    });

    expect(await screen.findByDisplayValue("Maria")).toBeInTheDocument();
    expect(screen.getByText("Source: gliner")).toBeInTheDocument();
  });

  it("automatically aligns and masks audio while saving PII", async () => {
    const alignmentDeferred = createDeferred({
      task_id: "task-1",
      transcript_hash: "hash",
      model: "test-aligner",
      generated_at: new Date().toISOString(),
      words: [
        {
          index: 0,
          text: "phone",
          normalized_text: "PHONE",
          start_char: 3,
          end_char: 8,
          start_seconds: 0.1,
          end_seconds: 0.4,
          score: 0.95,
        },
      ],
    });
    const maskingDeferred = createDeferred({
      task_id: "task-1",
      masked_audio_url: "/api/v1/media/audio/masked-token",
      mask_mode: "silence",
      expires_in_seconds: 300,
      generated_at: new Date().toISOString(),
      masked_intervals: [{ start_seconds: 0.1, end_seconds: 0.4, labels: ["OTHER"], text: "1234567890" }],
      accepted_intervals: [{ start_seconds: 0.1, end_seconds: 0.4, labels: ["OTHER"], text: "1234567890" }],
      alignment_intervals: [{ start_seconds: 0.1, end_seconds: 0.4, labels: ["OTHER"], text: "1234567890" }],
      words: [],
    });
    generateTaskAlignment.mockReturnValueOnce(alignmentDeferred.promise);
    maskTaskPIIAudio.mockReturnValueOnce(maskingDeferred.promise);

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my phone 1234567890" } });
    act(() => {
      textarea.setSelectionRange(9, 19);
      fireEvent.select(textarea);
    });
    fireEvent.keyDown(textarea, { key: "m", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Save PII" }));

    expect(await screen.findByText("Aligning and masking...")).toBeInTheDocument();
    await waitFor(() => expect(generateTaskAlignment).toHaveBeenCalledWith("test-token", "task-1", false));

    await act(async () => {
      alignmentDeferred.resolve(alignmentDeferred.promiseValue);
      await Promise.resolve();
    });
    await waitFor(() => expect(maskTaskPIIAudio).toHaveBeenCalledWith("test-token", "task-1", false, "silence"));

    await act(async () => {
      maskingDeferred.resolve(maskingDeferred.promiseValue);
      await Promise.resolve();
    });

    expect(await screen.findByText("Masked Audio Preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PII Saved" })).toBeInTheDocument();
  });

  it("does not expose manual status changes from the workspace", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", altKey: true }));
    });

    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(patchTaskCombined).not.toHaveBeenCalledWith(
      "test-token",
      "task-1",
      expect.objectContaining({ status: "Completed" })
    );
  });

  it("opens the next task from the keyboard only after required sections are verified", async () => {
    fetchTask.mockResolvedValueOnce({ ...mockTask, next_task_id: "task-2" });
    startTask.mockResolvedValueOnce({
      task: {
        ...mockTask,
        status: "In Progress",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        next_task_id: "task-2",
        version: 2,
      },
    });
    patchTaskCombined.mockResolvedValueOnce({
      task: {
        ...mockTask,
        status: "Completed",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        next_task_id: "task-2",
        version: 3,
      },
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    });
    expect(push).not.toHaveBeenCalledWith("/tasks/task-2");

    fireEvent.click(screen.getByRole("button", { name: "Save Transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Save PII" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Audio Masking" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Metadata" }));

    await screen.findByRole("button", { name: "Save and Next" });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/task-2"));
  });

  it("shows keyboard shortcuts and saves the next task with Ctrl Enter", async () => {
    fetchTask.mockResolvedValueOnce({ ...mockTask, next_task_id: "task-2" });
    startTask.mockResolvedValueOnce({
      task: {
        ...mockTask,
        status: "In Progress",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        next_task_id: "task-2",
        version: 2,
      },
    });
    patchTaskCombined.mockResolvedValueOnce({
      task: {
        ...mockTask,
        status: "Completed",
        assignee_id: "annotator-1",
        assignee_name: "Annotator",
        assignee_email: "annotator@test.com",
        next_task_id: "task-2",
        version: 3,
      },
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Space")).toBeInTheDocument();
    expect(screen.getByText("Play / pause audio")).toBeInTheDocument();
    expect(screen.getByText("Ctrl + Enter")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Save PII" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Audio Masking" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Metadata" }));

    await screen.findByRole("button", { name: "Save and Next" });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/task-2"));
  });

  it("gives reviewers a focused approve or reject decision panel", async () => {
    authState.user = {
      id: "reviewer-1",
      email: "reviewer@test.com",
      full_name: "Reviewer",
      role: "REVIEWER",
    };
    fetchTask.mockResolvedValueOnce({
      ...mockTask,
      status: "Needs Review",
      assignee_id: "reviewer-1",
      assignee_name: "Reviewer",
      assignee_email: "reviewer@test.com",
      final_transcript: "Ready for review",
    });
    patchTaskCombined.mockResolvedValueOnce({
      task: {
        ...mockTask,
        status: "Rejected",
        assignee_id: "reviewer-1",
        assignee_name: "Reviewer",
        assignee_email: "reviewer@test.com",
        version: 2,
      },
    });

    render(<TaskWorkspacePage />);
    await screen.findByText("Review Decision");

    expect(screen.getByText("Corrected transcript")).toBeInTheDocument();
    expect(screen.getByText("PII tags")).toBeInTheDocument();
    expect(screen.getByText("Masked audio")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Review rejection reason"), {
      target: { value: "PII masking needs another pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject Task" }));

    await waitFor(() =>
      expect(patchTaskCombined).toHaveBeenCalledWith(
        "test-token",
        "task-1",
        expect.objectContaining({
          status: "Rejected",
          comment: "PII masking needs another pass",
        })
      )
    );
  });

  it("generates alignment for word playback", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    fireEvent.change(screen.getByLabelText("Final Transcript"), {
      target: { value: "hello world" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Align Words" })[0]);

    await waitFor(() => expect(generateTaskAlignment).toHaveBeenCalledWith("test-token", "task-1", false));
    expect(await screen.findByRole("button", { name: "hello" })).toBeInTheDocument();
  });

  it("saves pii annotations and generates masked audio preview", async () => {
    const { container } = render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my phone 1234567890" } });
    act(() => {
      textarea.setSelectionRange(9, 19);
      fireEvent.select(textarea);
    });
    fireEvent.keyDown(textarea, { key: "m", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Mask PII" }));

    await waitFor(() => expect(patchTaskCombined).toHaveBeenCalled());
    await waitFor(() => expect(maskTaskPIIAudio).toHaveBeenCalledWith("test-token", "task-1", false, "silence"));
    expect(await screen.findByText("Masked Audio Preview")).toBeInTheDocument();

    const visibleAudioPlayers = Array.from(container.querySelectorAll("audio[controls]"));
    expect(visibleAudioPlayers.length).toBeGreaterThanOrEqual(2);
    for (const audio of visibleAudioPlayers) {
      expect(audio).toHaveAttribute("controlsList", expect.stringContaining("nodownload"));
      expect(fireEvent.contextMenu(audio)).toBe(false);
    }
  });

  it("lets taggers choose beep masking before generating the preview", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my phone 1234567890" } });
    act(() => {
      textarea.setSelectionRange(9, 19);
      fireEvent.select(textarea);
    });
    fireEvent.keyDown(textarea, { key: "m", altKey: true });
    fireEvent.click(screen.getByRole("radio", { name: "Beep" }));
    fireEvent.click(screen.getByRole("button", { name: "Mask PII" }));

    await waitFor(() => expect(maskTaskPIIAudio).toHaveBeenCalledWith("test-token", "task-1", false, "beep"));
  });

  it("regenerates masked audio with adjusted waveform mask windows", async () => {
    render(<TaskWorkspacePage />);
    await screen.findByText("Task OUT-001");

    const textarea = screen.getByLabelText("Final Transcript") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my phone 1234567890" } });
    act(() => {
      textarea.setSelectionRange(9, 19);
      fireEvent.select(textarea);
    });
    fireEvent.keyDown(textarea, { key: "m", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Mask PII" }));

    await screen.findByText("PII Mask Windows");
    expect(screen.queryByText("Window")).not.toBeInTheDocument();
    expect(screen.queryByText("Original Check")).not.toBeInTheDocument();
    expect(screen.queryByText("Masked Check")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mask end time for PHONE")).toHaveValue(0.4);
    expect(screen.getByLabelText("Mask end time for PHONE")).toHaveAttribute("step", "0.001");
    fireEvent.change(screen.getByLabelText("Mask end time for PHONE"), { target: { value: "0.456" } });
    fireEvent.click(await screen.findByRole("button", { name: "Update Mask" }));

    await waitFor(() =>
      expect(maskTaskPIIAudio).toHaveBeenLastCalledWith("test-token", "task-1", false, "silence", [
        { start_seconds: 0, end_seconds: 0.456, labels: ["PHONE"], text: "1234567890" },
      ])
    );
  });
});

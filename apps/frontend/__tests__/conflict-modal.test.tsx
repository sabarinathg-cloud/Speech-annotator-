import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConflictModal } from "@/components/conflict-modal";

describe("ConflictModal", () => {
  it("renders conflict fields and triggers actions", () => {
    const onUseMine = vi.fn();
    const onUseServer = vi.fn();
    const onMerge = vi.fn();

    render(
      <ConflictModal
        open
        serverTask={{
          id: "task-1",
          external_id: "OUT-001",
          file_location: "local:///tmp/audio.mp3",
          final_transcript: "",
          notes: "",
          status: "In Progress",
          speaker_gender: null,
          speaker_role: null,
          language: null,
          channel: null,
          duration_seconds: null,
          custom_metadata: {},
          original_row: {},
          pii_annotations: [],
          assignee_id: null,
          assignee_name: null,
          assignee_email: null,
          last_tagger_id: null,
          last_tagger_name: null,
          last_tagger_email: null,
          version: 3,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_saved_at: new Date().toISOString(),
          transcript_variants: [],
          alignment_words: [],
          alignment_model: null,
          alignment_updated_at: null,
          masked_audio_available: false,
          masked_audio_updated_at: null,
          masked_audio_intervals: [],
          masked_audio_reference_intervals: [],
          masked_audio_alignment_intervals: [],
          masked_audio_mode: null,
          prev_task_id: null,
          next_task_id: null
        }}
        conflictingFields={["final_transcript", "notes"]}
        onUseMine={onUseMine}
        onUseServer={onUseServer}
        onMerge={onMerge}
      />
    );

    expect(screen.getByText(/final_transcript, notes/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Use Server Version"));
    fireEvent.click(screen.getByText("Keep My Changes"));
    fireEvent.click(screen.getByText("Merge and Save"));

    expect(onUseServer).toHaveBeenCalledTimes(1);
    expect(onUseMine).toHaveBeenCalledTimes(1);
    expect(onMerge).toHaveBeenCalledTimes(1);
  });
});

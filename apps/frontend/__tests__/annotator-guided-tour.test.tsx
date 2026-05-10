import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnnotatorGuidedTour,
  type AnnotatorGuidedTourMilestone,
  type AnnotatorGuidedTourStep,
} from "@/components/annotator-guided-tour";

const steps: AnnotatorGuidedTourStep[] = [
  {
    id: "assignment",
    title: "Start with the assignment",
    body: "Open the assigned task and confirm the work context.",
    modes: ["quick", "full"],
  },
  {
    id: "transcript",
    title: "Correct the transcript",
    body: "Edit the transcript before moving forward.",
    modes: ["quick", "full"],
    requiredAction: {
      id: "transcript-reviewed",
      label: "Edit or save the transcript",
      hint: "Change the transcript or save this checkpoint to unlock the next step.",
    },
    actionId: "focus-transcript",
    actionLabel: "Focus transcript",
  },
  {
    id: "metadata",
    title: "Verify metadata",
    body: "Check language, speaker role, and imported metadata.",
    modes: ["full"],
  },
  {
    id: "complete",
    title: "Complete the task",
    body: "Move the task to completed when every checkpoint is saved.",
    modes: ["quick", "full"],
    requiredAction: {
      id: "ready-to-complete",
      label: "Save every checkpoint",
      hint: "Transcript, PII, masking, and metadata must all be saved.",
    },
    actionId: "complete-task",
    actionLabel: "Complete task",
  },
];

const milestones: AnnotatorGuidedTourMilestone[] = [
  { id: "assignment", label: "Task opened", complete: true },
  { id: "transcript", label: "Transcript reviewed", complete: false, active: true },
  { id: "pii", label: "PII reviewed", complete: false },
  { id: "complete", label: "Task completed", complete: false },
];

describe("AnnotatorGuidedTour", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("offers full and quick tour modes with a workflow checklist", () => {
    render(
      <AnnotatorGuidedTour
        steps={steps}
        milestones={milestones}
        actionStatus={{
          "transcript-reviewed": { complete: true },
          "ready-to-complete": { complete: true },
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));

    const dialog = screen.getByRole("dialog", { name: "Annotator guided tour" });
    expect(within(dialog).getByRole("button", { name: "Full workflow tour" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(dialog).getByRole("button", { name: "Quick tour" })).toBeInTheDocument();
    expect(within(dialog).getByText("Step 1 of 4")).toBeInTheDocument();
    expect(within(dialog).getByText("Workflow checklist")).toBeInTheDocument();
    expect(within(dialog).getByText("Task opened")).toBeInTheDocument();
    expect(within(dialog).getByText("Done")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Quick tour" }));

    expect(within(dialog).getByRole("button", { name: "Quick tour" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("Step 1 of 3")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));

    expect(within(dialog).getByText("Complete the task")).toBeInTheDocument();
    expect(within(dialog).queryByText("Verify metadata")).not.toBeInTheDocument();
  });

  it("does not blur the page behind the guided tour", () => {
    render(<AnnotatorGuidedTour steps={steps} milestones={milestones} />);

    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));

    expect(screen.getByRole("dialog", { name: "Annotator guided tour" })).toBeInTheDocument();
    expect(document.querySelector('[class*="backdrop-blur"]')).not.toBeInTheDocument();
  });

  it("blocks next until the required workflow action is complete", async () => {
    const onStepAction = vi.fn();
    const { rerender } = render(
      <AnnotatorGuidedTour
        steps={steps}
        milestones={milestones}
        actionStatus={{
          "transcript-reviewed": { complete: false },
          "ready-to-complete": { complete: false },
        }}
        onStepAction={onStepAction}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start annotator guided tour" }));
    let dialog = screen.getByRole("dialog", { name: "Annotator guided tour" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next step" }));

    expect(within(dialog).getByText("Correct the transcript")).toBeInTheDocument();
    expect(within(dialog).getByText("Complete this step to continue")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Next step" })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Focus transcript" }));

    expect(onStepAction).toHaveBeenCalledWith(expect.objectContaining({ id: "transcript" }));

    rerender(
      <AnnotatorGuidedTour
        steps={steps}
        milestones={[{ ...milestones[0] }, { ...milestones[1], complete: true }, milestones[2], milestones[3]]}
        actionStatus={{
          "transcript-reviewed": { complete: true },
          "ready-to-complete": { complete: false },
        }}
        onStepAction={onStepAction}
      />
    );

    dialog = screen.getByRole("dialog", { name: "Annotator guided tour" });
    expect(within(dialog).getByText("Ready")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Next step" })).toBeEnabled();
  });
});

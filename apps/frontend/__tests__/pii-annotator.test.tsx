import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PIIAnnotator } from "@/components/pii-annotator";

describe("PIIAnnotator", () => {
  afterEach(() => {
    cleanup();
  });

  function selectText(textElement: HTMLElement, start: number, end: number) {
    const textNode = textElement.firstChild;
    if (!textNode) {
      throw new Error("Expected selectable transcript text");
    }
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  it("adds a PII annotation from selected transcript text instead of range sliders", () => {
    const onChange = vi.fn();

    render(
      <PIIAnnotator
        transcript="alpha 1234567890 omega"
        annotations={[]}
        onChange={onChange}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    selectText(screen.getByText("alpha 1234567890 omega"), 6, 16);
    fireEvent.mouseUp(screen.getByText("alpha 1234567890 omega"));

    expect(screen.queryByLabelText(/PII start handle/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/PII end handle/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New PII label"), {
      target: { value: "PHONE" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Add Selection/i }).find((button) => !button.hasAttribute("disabled"))!);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        label: "PHONE",
        start: 6,
        end: 16,
        value: "1234567890",
        source: "manual",
        confidence: null,
      }),
    ]);
  });

  it("uses admin-provided label options", () => {
    const onChange = vi.fn();

    render(
      <PIIAnnotator
        transcript="passport A1234567"
        annotations={[]}
        labels={[{ key: "PASSPORT", display_name: "Passport", color: "#0f766e" }]}
        onChange={onChange}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    selectText(screen.getByText("passport A1234567"), 9, 17);
    fireEvent.mouseUp(screen.getByText("passport A1234567"));
    fireEvent.click(screen.getByRole("button", { name: /Add Selection/i }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        label: "PASSPORT",
        value: "A1234567",
      }),
    ]);
  });

  it("applies the same label to every matching transcript value", () => {
    const onChange = vi.fn();
    const existing = [
      {
        id: "pii-1",
        label: "PERSON",
        start: 0,
        end: 4,
        value: "John",
        source: "manual",
        confidence: null,
      },
    ];

    render(
      <PIIAnnotator
        transcript="John called John again"
        annotations={existing}
        labels={[{ key: "PERSON", display_name: "Person", color: "#2563eb" }]}
        onChange={onChange}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply PERSON to all John matches" }));

    expect(onChange).toHaveBeenCalledWith([
      existing[0],
      expect.objectContaining({
        label: "PERSON",
        start: 12,
        end: 16,
        value: "John",
        source: "manual",
      }),
    ]);
  });

  it("renders overlapping PII once in the transcript and moves the warning into review", () => {
    render(
      <PIIAnnotator
        transcript="Call 118 Market Street now"
        annotations={[
          {
            id: "short-address",
            label: "ADDRESS",
            start: 5,
            end: 8,
            value: "118",
            source: "piiranha",
            confidence: 1,
          },
          {
            id: "full-address",
            label: "ADDRESS",
            start: 5,
            end: 22,
            value: "118 Market Street",
            source: "auto",
            confidence: 0.9,
          },
        ]}
        onChange={vi.fn()}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Selectable transcript for PII").textContent).toBe(
      "Call 118 Market Street now"
    );
    expect(screen.getByText("Overlap review needed.")).toBeInTheDocument();
    expect(screen.getByText("2 overlaps")).toBeInTheDocument();
    expect(
      screen
        .getByRole("listbox", { name: "PII entity review queue" })
        .querySelectorAll('[role="option"]')
    ).toHaveLength(2);
    expect(screen.getByText("Overlap warning")).toBeInTheDocument();
  });

  it("uses a compact queue with one focused editor", () => {
    render(
      <PIIAnnotator
        transcript="Call 118 Market Street now"
        annotations={[
          {
            id: "short-address",
            label: "ADDRESS",
            start: 5,
            end: 8,
            value: "118",
            source: "piiranha",
            confidence: 1,
          },
          {
            id: "full-address",
            label: "ADDRESS",
            start: 5,
            end: 22,
            value: "118 Market Street",
            source: "auto",
            confidence: 0.9,
          },
        ]}
        onChange={vi.fn()}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    expect(screen.getByRole("listbox", { name: "PII entity review queue" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^PII value for/i)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Use Selection" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("option", { name: /118 Market Street/i }));

    expect(screen.getByLabelText("PII value for ADDRESS")).toHaveValue("118 Market Street");
  });

  it("groups the same text from multiple models or labels into one review item", () => {
    const onChange = vi.fn();

    render(
      <PIIAnnotator
        transcript="Ship it to San Francisco tomorrow"
        annotations={[
          {
            id: "sf-address",
            label: "ADDRESS",
            start: 11,
            end: 24,
            value: "San Francisco",
            source: "gliner",
            confidence: 0.91,
          },
          {
            id: "sf-location",
            label: "LOCATION",
            start: 11,
            end: 24,
            value: "San Francisco",
            source: "piiranha",
            confidence: 0.89,
          },
        ]}
        onChange={onChange}
        onDetect={vi.fn()}
        onClear={vi.fn()}
      />
    );

    expect(
      screen
        .getByRole("listbox", { name: "PII entity review queue" })
        .querySelectorAll('[role="option"]')
    ).toHaveLength(1);
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByText("1 grouped")).toBeInTheDocument();
    expect(screen.getAllByText("2 models").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 labels").length).toBeGreaterThan(0);
    expect(screen.queryByText("Overlap review needed.")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("PII label for San Francisco"), {
      target: { value: "LOCATION" },
    });

    const nextAnnotations = onChange.mock.calls[0][0];
    expect(nextAnnotations.map((annotation: { label: string }) => annotation.label)).toEqual([
      "LOCATION",
      "LOCATION",
    ]);
  });
});

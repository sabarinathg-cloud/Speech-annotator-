import type { PIIAnnotation } from "@outcomes/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  labelColor,
  labelDisplayName,
  labelsWithAnnotationKeys,
  toPIILabelOptions,
  type PIILabelOption,
} from "@/lib/pii-labels";

interface PIIAnnotatorProps {
  transcript: string;
  annotations: PIIAnnotation[];
  onChange: (annotations: PIIAnnotation[]) => void;
  onDetect: () => void | Promise<void>;
  onClear: () => void;
  labels?: PIILabelOption[];
  detecting?: boolean;
  detectionMessage?: string | null;
}

interface SelectedTranscriptRange {
  start: number;
  end: number;
  text: string;
}

interface PIIReviewItem {
  id: string;
  annotationIds: string[];
  annotations: PIIAnnotation[];
  primary: PIIAnnotation;
  value: string;
  normalizedValue: string;
  start: number;
  end: number;
  labels: string[];
  sources: string[];
}

function createManualPIIId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSelectedTranscriptRange(
  container: HTMLElement,
  transcript: string
): SelectedTranscriptRange | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const selectedNode =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!selectedNode || !container.contains(selectedNode)) {
    return null;
  }

  const beforeSelection = document.createRange();
  beforeSelection.selectNodeContents(container);
  beforeSelection.setEnd(range.startContainer, range.startOffset);

  const rawText = range.toString();
  const leadingWhitespace = rawText.length - rawText.trimStart().length;
  const trailingWhitespace = rawText.length - rawText.trimEnd().length;
  const start = Math.max(
    0,
    Math.min(transcript.length, beforeSelection.toString().length + leadingWhitespace)
  );
  const end = Math.max(
    start,
    Math.min(transcript.length, start + rawText.length - leadingWhitespace - trailingWhitespace)
  );

  if (end <= start) {
    return null;
  }

  return { start, end, text: transcript.slice(start, end) };
}

function renderHighlightedTranscript(
  transcript: string,
  annotations: PIIAnnotation[],
  labelOptions: PIILabelOption[]
) {
  if (!transcript) {
    return <span className="text-[#7b7696]">No final transcript yet.</span>;
  }
  if (annotations.length === 0) {
    return <span>{transcript}</span>;
  }

  const safeAnnotations = annotations
    .map((annotation) => ({
      ...annotation,
      start: Math.max(0, Math.min(transcript.length, annotation.start)),
      end: Math.max(0, Math.min(transcript.length, annotation.end)),
    }))
    .filter((annotation) => annotation.end > annotation.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (safeAnnotations.length === 0) {
    return <span>{transcript}</span>;
  }

  const boundaries = new Set<number>([0, transcript.length]);
  safeAnnotations.forEach((annotation) => {
    boundaries.add(annotation.start);
    boundaries.add(annotation.end);
  });

  const points = Array.from(boundaries).sort((a, b) => a - b);
  const nodes: ReactNode[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) {
      continue;
    }

    const text = transcript.slice(start, end);
    const covering = safeAnnotations.filter(
      (annotation) => annotation.start < end && start < annotation.end
    );
    if (covering.length === 0) {
      nodes.push(<span key={`txt-${start}-${end}`}>{text}</span>);
      continue;
    }

    const distinctValues = new Set(covering.map((annotation) => normalizePIIValue(annotation.value)));
    if (covering.length > 1 && distinctValues.size > 1) {
      const labels = Array.from(
        new Set(covering.map((annotation) => labelDisplayName(annotation.label, labelOptions)))
      ).join(", ");
      nodes.push(
        <mark
          key={`overlap-${start}-${end}-${covering.map((annotation) => annotation.id).join("-")}`}
          className="rounded border px-0.5 font-medium"
          style={{
            backgroundColor: "#fff7ed",
            borderColor: "#fb923c",
            color: "#9a3412",
          }}
          title={`Overlapping PII: ${labels}`}
        >
          {text}
        </mark>
      );
      continue;
    }

    const annotation = covering[0];
    const labelCount = new Set(covering.map((item) => item.label)).size;
    const sourceCount = new Set(covering.map(sourceKey)).size;
    nodes.push(
      <mark
        key={`pii-${annotation.id}-${start}-${end}`}
        className="rounded border px-0.5 font-medium"
        style={labelColorStyle(annotation.label, labelOptions)}
        title={`${labelDisplayName(annotation.label, labelOptions)}${
          annotation.confidence !== null ? ` (${Math.round(annotation.confidence * 100)}%)` : ""
        }${sourceCount > 1 ? `, ${sourceCount} models` : ""}${
          labelCount > 1 ? `, ${labelCount} labels` : ""
        }`}
      >
        {text}
      </mark>
    );
  }
  return nodes;
}

function labelColorStyle(label: string, labelOptions: PIILabelOption[]): CSSProperties {
  const color = labelColor(label, labelOptions);
  return {
    backgroundColor: `${color}1f`,
    borderColor: `${color}55`,
    color,
  };
}

function normalizePIIValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function sourceKey(annotation: PIIAnnotation): string {
  return annotation.source?.trim() || "manual";
}

function reviewItemId(annotations: PIIAnnotation[]): string {
  return annotations.map((annotation) => annotation.id).sort().join("|");
}

function rangesOverlapOrNearlyMatch(
  annotation: PIIAnnotation,
  item: Pick<PIIReviewItem, "start" | "end">
): boolean {
  const overlaps = annotation.start < item.end && item.start < annotation.end;
  const nearlySameRange = Math.abs(annotation.start - item.start) <= 2 && Math.abs(annotation.end - item.end) <= 2;
  return overlaps || nearlySameRange;
}

function buildReviewItems(annotations: PIIAnnotation[]): PIIReviewItem[] {
  const sorted = [...annotations].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.label.localeCompare(b.label)
  );
  const groups: Array<Omit<PIIReviewItem, "id" | "annotationIds" | "labels" | "sources">> = [];

  sorted.forEach((annotation) => {
    const normalizedValue = normalizePIIValue(annotation.value);
    if (!normalizedValue) {
      return;
    }
    const existing = groups.find(
      (item) =>
        item.normalizedValue === normalizedValue && rangesOverlapOrNearlyMatch(annotation, item)
    );
    if (existing) {
      existing.annotations.push(annotation);
      existing.start = Math.min(existing.start, annotation.start);
      existing.end = Math.max(existing.end, annotation.end);
      if ((annotation.confidence ?? -1) > (existing.primary.confidence ?? -1)) {
        existing.primary = annotation;
      }
      return;
    }
    groups.push({
      annotations: [annotation],
      primary: annotation,
      value: annotation.value.trim(),
      normalizedValue,
      start: annotation.start,
      end: annotation.end,
    });
  });

  return groups.map((item) => {
    const labels = Array.from(new Set(item.annotations.map((annotation) => annotation.label))).sort();
    const sources = Array.from(new Set(item.annotations.map(sourceKey))).sort();
    return {
      ...item,
      id: reviewItemId(item.annotations),
      annotationIds: item.annotations.map((annotation) => annotation.id),
      labels,
      sources,
    };
  });
}

function overlappingReviewItemIds(items: PIIReviewItem[]): Set<string> {
  const ids = new Set<string>();
  items.forEach((current, index) => {
    items.slice(index + 1).forEach((next) => {
      if (current.start < next.end && next.start < current.end) {
        ids.add(current.id);
        ids.add(next.id);
      }
    });
  });
  return ids;
}

function sortedReviewItems(items: PIIReviewItem[], overlaps: Set<string>): PIIReviewItem[] {
  return [...items].sort((a, b) => {
    const overlapRank = Number(overlaps.has(b.id)) - Number(overlaps.has(a.id));
    if (overlapRank !== 0) return overlapRank;
    return a.start - b.start || a.end - b.end || a.value.localeCompare(b.value);
  });
}

function annotationLabelSummary(
  annotations: PIIAnnotation[],
  labelOptions: PIILabelOption[]
): Array<{ key: string; label: string; count: number; style: CSSProperties }> {
  const counts = new Map<string, number>();
  annotations.forEach((annotation) => {
    counts.set(annotation.label, (counts.get(annotation.label) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: labelDisplayName(key, labelOptions),
      count,
      style: labelColorStyle(key, labelOptions),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function reviewItemSourceLabel(item: PIIReviewItem): string {
  if (item.sources.length > 1) {
    return `${item.sources.length} models`;
  }
  const source = item.sources[0] ?? "manual";
  return source === "manual" ? "Source: manual" : `Source: ${source}`;
}

function reviewItemLabelSummary(item: PIIReviewItem, labelOptions: PIILabelOption[]): string {
  return item.labels.map((label) => labelDisplayName(label, labelOptions)).join(", ");
}

function confidenceLabel(annotation: PIIAnnotation): string {
  if (annotation.confidence === null) {
    return "Manual review";
  }
  return `Confidence ${Math.round(annotation.confidence * 100)}%`;
}

function findUnannotatedValueMatches(
  transcript: string,
  annotations: PIIAnnotation[],
  annotation: PIIAnnotation
): PIIAnnotation[] {
  if (!annotation.value.trim()) return [];
  const matches: PIIAnnotation[] = [];
  let cursor = 0;
  while (cursor < transcript.length) {
    const start = transcript.indexOf(annotation.value, cursor);
    if (start === -1) break;
    const end = start + annotation.value.length;
    const alreadyCovered = annotations.some(
      (item) => item.start === start && item.end === end && item.label === annotation.label
    );
    if (!alreadyCovered) {
      matches.push({
        id: createManualPIIId(),
        label: annotation.label,
        start,
        end,
        value: transcript.slice(start, end),
        source: "manual",
        confidence: null,
      });
    }
    cursor = end;
  }
  return matches;
}

export function PIIAnnotator({
  transcript,
  annotations,
  onChange,
  onDetect,
  onClear,
  labels,
  detecting = false,
  detectionMessage = null,
}: PIIAnnotatorProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [selectedRange, setSelectedRange] = useState<SelectedTranscriptRange | null>(null);
  const labelOptions = useMemo(() => toPIILabelOptions(labels), [labels]);
  const annotationLabelOptions = useMemo(
    () => labelsWithAnnotationKeys(labelOptions, annotations),
    [annotations, labelOptions]
  );
  const [newLabel, setNewLabel] = useState("PERSON");
  const rawReviewItems = useMemo(() => buildReviewItems(annotations), [annotations]);
  const reviewItemOverlaps = useMemo(
    () => overlappingReviewItemIds(rawReviewItems),
    [rawReviewItems]
  );
  const reviewItems = useMemo(
    () => sortedReviewItems(rawReviewItems, reviewItemOverlaps),
    [rawReviewItems, reviewItemOverlaps]
  );
  const labelSummary = useMemo(
    () => annotationLabelSummary(reviewItems.map((item) => item.primary), annotationLabelOptions),
    [reviewItems, annotationLabelOptions]
  );
  const matchCountByReviewItemId = useMemo(() => {
    const counts = new Map<string, number>();
    reviewItems.forEach((item) => {
      counts.set(
        item.id,
        findUnannotatedValueMatches(transcript, annotations, item.primary).length
      );
    });
    return counts;
  }, [annotations, reviewItems, transcript]);
  const overlapCount = reviewItemOverlaps.size;
  const groupedDetectionCount = Math.max(0, annotations.length - reviewItems.length);
  const [selectedReviewItemId, setSelectedReviewItemId] = useState<string | null>(null);
  const activeItem = useMemo(
    () =>
      reviewItems.find((item) => item.id === selectedReviewItemId) ??
      reviewItems[0] ??
      null,
    [reviewItems, selectedReviewItemId]
  );
  const activeItemIndex = activeItem
    ? reviewItems.findIndex((item) => item.id === activeItem.id)
    : -1;
  const activeHasOverlap = activeItem ? reviewItemOverlaps.has(activeItem.id) : false;
  const activeMatchCount = activeItem
    ? matchCountByReviewItemId.get(activeItem.id) ?? 0
    : 0;

  useEffect(() => {
    if (labelOptions.some((label) => label.key === newLabel)) {
      return;
    }
    setNewLabel(labelOptions[0]?.key ?? "OTHER");
  }, [labelOptions, newLabel]);

  useEffect(() => {
    if (annotations.length === 0) {
      setSelectedReviewItemId(null);
      return;
    }
    if (selectedReviewItemId && reviewItems.some((item) => item.id === selectedReviewItemId)) {
      return;
    }
    setSelectedReviewItemId(reviewItems[0]?.id ?? null);
  }, [annotations.length, reviewItems, selectedReviewItemId]);

  const captureSelection = useCallback(() => {
    if (!transcriptRef.current) {
      return;
    }
    setSelectedRange(getSelectedTranscriptRange(transcriptRef.current, transcript));
  }, [transcript]);

  function clearTranscriptSelection() {
    window.getSelection()?.removeAllRanges();
    setSelectedRange(null);
  }

  function addSelectedAnnotation() {
    if (!selectedRange) {
      return;
    }
    const nextAnnotation: PIIAnnotation = {
      id: createManualPIIId(),
      label: newLabel,
      start: selectedRange.start,
      end: selectedRange.end,
      value: selectedRange.text,
      source: "manual",
      confidence: null,
    };
    setSelectedReviewItemId(reviewItemId([nextAnnotation]));
    onChange([
      ...annotations,
      nextAnnotation,
    ].sort((a, b) => a.start - b.start || a.end - b.end));
    clearTranscriptSelection();
  }

  function updateReviewItem(item: PIIReviewItem, patch: Partial<PIIAnnotation>) {
    const itemIds = new Set(item.annotationIds);
    onChange(
      annotations.map((annotation) => {
        if (!itemIds.has(annotation.id)) return annotation;
        const start = Math.max(0, Math.min(transcript.length, Number(patch.start ?? annotation.start)));
        const end = Math.max(start + 1, Math.min(transcript.length, Number(patch.end ?? annotation.end)));
        return {
          ...annotation,
          ...patch,
          start,
          end,
          value: transcript.slice(start, end),
          source: patch.source !== undefined ? patch.source : annotation.source,
        };
      })
    );
  }

  function applySelectionToReviewItem(item: PIIReviewItem) {
    if (!selectedRange) {
      return;
    }
    updateReviewItem(item, {
      start: selectedRange.start,
      end: selectedRange.end,
      source: "manual",
      confidence: null,
    });
    clearTranscriptSelection();
  }

  function applyAnnotationToAllMatches(annotation: PIIAnnotation) {
    const matches = findUnannotatedValueMatches(transcript, annotations, annotation);
    if (matches.length === 0) return;
    onChange([...annotations, ...matches].sort((a, b) => a.start - b.start || a.end - b.end));
  }

  function removeReviewItem(item: PIIReviewItem) {
    const itemIds = new Set(item.annotationIds);
    const remainingItems = reviewItems.filter((reviewItem) => reviewItem.id !== item.id);
    setSelectedReviewItemId(remainingItems[0]?.id ?? null);
    onChange(annotations.filter((annotation) => !itemIds.has(annotation.id)));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-[#111827]">PII Review</h4>
          <p className="text-xs text-[#6b7280]">
            Review every detected entity, resolve overlaps, and keep only the final tags.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onDetect()}
            disabled={detecting}
            className="oa-btn-secondary px-2.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60"
          >
            {detecting ? "Detecting..." : "Detect PII"}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={detecting}
            className="oa-btn-quiet px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
          >
            Clear All
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
        <span className="rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-2.5 py-1 text-[11px] font-semibold text-[#374151]">
          {reviewItems.length} item{reviewItems.length === 1 ? "" : "s"}
        </span>
        {groupedDetectionCount > 0 ? (
          <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2.5 py-1 text-[11px] font-semibold text-[#1d4ed8]">
            {groupedDetectionCount} grouped
          </span>
        ) : null}
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
            overlapCount > 0
              ? "border-[#fdba74] bg-[#fff7ed] text-[#9a3412]"
              : "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]"
          }`}
        >
          {overlapCount > 0 ? `${overlapCount} overlap${overlapCount === 1 ? "" : "s"}` : "Clean"}
        </span>
        {labelSummary.length === 0 ? (
          <span className="text-[11px] text-[#6b7280]">No labels yet</span>
        ) : (
          labelSummary.slice(0, 4).map((item) => (
            <span
              key={item.key}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
              style={item.style}
            >
              <span>{item.label}</span>
              <span>{item.count}</span>
            </span>
          ))
        )}
        {labelSummary.length > 4 ? (
          <span className="rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-2.5 py-1 text-[11px] font-semibold text-[#6b7280]">
            +{labelSummary.length - 4} more
          </span>
        ) : null}
      </div>

      {detecting ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-[#c7d2fe] bg-[#eef2ff] px-3 py-2 text-xs text-[#3730a3]"
        >
          <div className="flex items-center gap-2 font-medium">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span>{detectionMessage ?? "Scanning transcript with all PII models..."}</span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1" aria-hidden="true">
            <span className="h-1.5 animate-pulse rounded-full bg-[#6366f1]" />
            <span className="h-1.5 animate-pulse rounded-full bg-[#8b5cf6] [animation-delay:120ms]" />
            <span className="h-1.5 animate-pulse rounded-full bg-[#06b6d4] [animation-delay:240ms]" />
          </div>
        </div>
      ) : null}

      <div
        ref={transcriptRef}
        aria-label="Selectable transcript for PII"
        tabIndex={0}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        className="max-h-36 select-text overflow-auto rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-sm leading-6 text-[#111827] focus:border-[#2563eb] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
      >
        {renderHighlightedTranscript(transcript, annotations, annotationLabelOptions)}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#dbeafe] bg-[#eff6ff] px-3 py-2">
        <span className="max-w-full truncate text-xs text-[#4b5563]">
          {selectedRange ? (
            <>
              Selected <span className="font-mono text-[#111827]">"{selectedRange.text}"</span>
            </>
          ) : (
            "No text selected"
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            aria-label="New PII label"
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            className="oa-select py-1.5 text-xs"
            style={labelColorStyle(newLabel, labelOptions)}
          >
            {labelOptions.map((label) => (
              <option key={label.key} value={label.key}>
                {label.display_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addSelectedAnnotation}
            disabled={!selectedRange}
            className="oa-btn-primary px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add Selection
          </button>
        </div>
      </div>

      {overlapCount > 0 ? (
        <div className="rounded-lg border border-[#fdba74] bg-[#fff7ed] px-3 py-2 text-xs text-[#9a3412]">
          <span className="font-semibold">Overlap review needed.</span> Check the highlighted
          rows first and remove or reselect duplicated spans.
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
            Entity review queue
          </h5>
          {activeItem ? (
            <span className="text-[11px] text-[#6b7280]">
              {activeItemIndex + 1} of {reviewItems.length} selected
            </span>
          ) : null}
        </div>
        {annotations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f8fafc] px-3 py-3 text-xs text-[#6b7280]">
            No PII entities added yet.
          </p>
        ) : (
          <div className="grid gap-2 xl:grid-cols-[1fr_minmax(260px,0.9fr)]">
            <div
              role="listbox"
              aria-label="PII entity review queue"
              className="max-h-64 overflow-auto rounded-lg border border-[#e5e7eb] bg-white"
            >
              {reviewItems.map((item, index) => {
                const hasOverlap = reviewItemOverlaps.has(item.id);
                const isActive = activeItem?.id === item.id;
                const displayLabel = labelDisplayName(item.primary.label, annotationLabelOptions);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => setSelectedReviewItemId(item.id)}
                    className={`grid w-full grid-cols-[auto,1fr,auto] items-center gap-2 border-b border-[#eef0f4] px-2.5 py-2 text-left last:border-b-0 ${
                      isActive
                        ? "bg-[#eef2ff] ring-1 ring-inset ring-[#c7d2fe]"
                        : hasOverlap
                          ? "bg-[#fffaf3] hover:bg-[#fff4e6]"
                          : "bg-white hover:bg-[#f8fafc]"
                    }`}
                  >
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[11px] font-semibold text-[#6b7280]">
                      {index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="mb-1 flex min-w-0 items-center gap-1.5">
                        <span
                          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold"
                          style={labelColorStyle(item.primary.label, annotationLabelOptions)}
                          title={displayLabel}
                        >
                          {displayLabel.charAt(0).toUpperCase()}
                        </span>
                        {hasOverlap ? (
                          <span className="shrink-0 rounded-full border border-[#fdba74] bg-[#fff7ed] px-1.5 py-0.5 text-[10px] font-semibold text-[#9a3412]">
                            Overlap
                          </span>
                        ) : null}
                        {item.sources.length > 1 ? (
                          <span className="shrink-0 rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-1.5 py-0.5 text-[10px] font-semibold text-[#1d4ed8]">
                            {item.sources.length} models
                          </span>
                        ) : null}
                        {item.labels.length > 1 ? (
                          <span className="shrink-0 rounded-full border border-[#d8b4fe] bg-[#faf5ff] px-1.5 py-0.5 text-[10px] font-semibold text-[#7e22ce]">
                            {item.labels.length} labels
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate font-mono text-xs text-[#111827]">
                        {item.value}
                      </span>
                    </span>
                    <span className="rounded-full border border-[#e5e7eb] bg-white px-2 py-0.5 text-[10px] font-semibold text-[#6b7280]">
                      {item.start}-{item.end}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeItem ? (
              <section
                aria-label="Selected PII entity"
                className={`rounded-lg border p-3 ${
                  activeHasOverlap ? "border-[#fdba74] bg-[#fffaf3]" : "border-[#e5e7eb] bg-[#fbfcfe]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                      Selected entity
                    </p>
                    <p className="text-xs text-[#6b7280]">
                      Range {activeItem.start}-{activeItem.end}
                    </p>
                  </div>
                  {activeHasOverlap ? (
                    <span className="rounded-full border border-[#fdba74] bg-[#fff7ed] px-2 py-0.5 text-[11px] font-semibold text-[#9a3412]">
                      Overlap warning
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 space-y-2">
                  <select
                    aria-label={`PII label for ${activeItem.value}`}
                    value={activeItem.primary.label}
                    onChange={(event) =>
                      updateReviewItem(activeItem, { label: event.target.value })
                    }
                    className="oa-select min-h-10 w-full py-1.5 text-sm font-semibold"
                    style={labelColorStyle(activeItem.primary.label, annotationLabelOptions)}
                  >
                    {annotationLabelOptions.map((label) => (
                      <option key={label.key} value={label.key}>
                        {label.display_name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={activeItem.value}
                    readOnly
                    aria-label={`PII value for ${activeItem.primary.label}`}
                    className="oa-input min-h-10 w-full py-1.5 font-mono text-sm text-[#374151]"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#6b7280]">
                    <span
                      className="rounded-full border border-[#e5e7eb] bg-white px-2 py-0.5"
                      title={activeItem.sources.join(", ")}
                    >
                      {reviewItemSourceLabel(activeItem)}
                    </span>
                    <span className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2 py-0.5 text-[#1d4ed8]">
                      {confidenceLabel(activeItem.primary)}
                    </span>
                    {activeItem.labels.length > 1 ? (
                      <span
                        className="rounded-full border border-[#d8b4fe] bg-[#faf5ff] px-2 py-0.5 font-semibold text-[#7e22ce]"
                        title={reviewItemLabelSummary(activeItem, annotationLabelOptions)}
                      >
                        {activeItem.labels.length} labels
                      </span>
                    ) : null}
                    {activeItem.annotations.length > 1 ? (
                      <span className="rounded-full border border-[#e5e7eb] bg-white px-2 py-0.5">
                        {activeItem.annotations.length} detections
                      </span>
                    ) : null}
                    {activeMatchCount > 0 ? (
                      <span className="rounded-full border border-[#bbf7d0] bg-[#f0fdf4] px-2 py-0.5 text-[#166534]">
                        {activeMatchCount} more match{activeMatchCount === 1 ? "" : "es"}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => applySelectionToReviewItem(activeItem)}
                    disabled={!selectedRange}
                    className="whitespace-nowrap rounded-md border border-[#c7d2fe] bg-white px-1.5 py-1.5 text-[11px] font-medium text-[#3730a3] hover:bg-[#eef2ff] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Use Selection
                  </button>
                  <button
                    type="button"
                    aria-label={`Apply ${activeItem.primary.label} to all ${activeItem.value} matches`}
                    onClick={() => applyAnnotationToAllMatches(activeItem.primary)}
                    disabled={activeMatchCount === 0}
                    className="whitespace-nowrap rounded-md border border-[#bfdbfe] bg-white px-1.5 py-1.5 text-[11px] font-medium text-[#1d4ed8] hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Apply All
                  </button>
                  <button
                    type="button"
                    onClick={() => removeReviewItem(activeItem)}
                    className="whitespace-nowrap rounded-md border border-[#f0c8c8] bg-white px-1.5 py-1.5 text-[11px] font-medium text-[#a13a3a] hover:bg-[#fff2f2]"
                  >
                    Remove
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

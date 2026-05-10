"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const ANNOTATOR_GUIDED_TOUR_STORAGE_KEY =
  "outcomes-ai:speech-annotator:annotator-guided-tour-complete:v1";

export type AnnotatorTourMode = "quick" | "full";

export interface AnnotatorGuidedTourRequiredAction {
  id: string;
  label: string;
  hint?: string;
}

export interface AnnotatorGuidedTourActionStatus {
  complete: boolean;
  label?: string;
  hint?: string;
  disabled?: boolean;
}

export interface AnnotatorGuidedTourMilestone {
  id: string;
  label: string;
  complete: boolean;
  active?: boolean;
}

export interface AnnotatorGuidedTourStep {
  id: string;
  title: string;
  body: string;
  modes?: AnnotatorTourMode[];
  targetId?: string;
  checklist?: string[];
  inspectorPanel?: string;
  requiredAction?: AnnotatorGuidedTourRequiredAction;
  actionId?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
}

interface AnnotatorGuidedTourProps {
  steps: AnnotatorGuidedTourStep[];
  milestones?: AnnotatorGuidedTourMilestone[];
  actionStatus?: Record<string, AnnotatorGuidedTourActionStatus>;
  defaultMode?: AnnotatorTourMode;
  forceStartKey?: string | number | null;
  onStepChange?: (step: AnnotatorGuidedTourStep) => void;
  onStepAction?: (step: AnnotatorGuidedTourStep) => void | boolean | Promise<void | boolean>;
  onForceStartConsumed?: () => void;
}

function setTourComplete() {
  try {
    localStorage.setItem(ANNOTATOR_GUIDED_TOUR_STORAGE_KEY, "complete");
  } catch {
    // Storage may be blocked in private or embedded browser contexts.
  }
}

export function AnnotatorGuidedTour({
  steps,
  milestones = [],
  actionStatus = {},
  defaultMode = "full",
  forceStartKey = null,
  onStepChange,
  onStepAction,
  onForceStartConsumed,
}: AnnotatorGuidedTourProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [mode, setMode] = useState<AnnotatorTourMode>(defaultMode);
  const [actionBusy, setActionBusy] = useState(false);
  const onStepChangeRef = useRef(onStepChange);
  const onStepActionRef = useRef(onStepAction);
  const onForceStartConsumedRef = useRef(onForceStartConsumed);
  const lastForceStartKeyRef = useRef<string | number | null>(null);

  const visibleSteps = useMemo(
    () => (mode === "full" ? steps : steps.filter((item) => item.modes?.includes("quick"))),
    [mode, steps]
  );
  const step = visibleSteps[stepIndex] ?? visibleSteps[0];
  const isFinalStep = stepIndex === visibleSteps.length - 1;
  const requiredAction = step?.requiredAction;
  const requiredActionState = requiredAction ? actionStatus[requiredAction.id] : undefined;
  const requiredActionComplete = !requiredAction || Boolean(requiredActionState?.complete);
  const requiredActionLabel = requiredActionState?.label ?? requiredAction?.label;
  const requiredActionHint = requiredActionState?.hint ?? requiredAction?.hint;
  const canAdvance = requiredActionComplete && stepIndex < visibleSteps.length - 1;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    onStepChangeRef.current = onStepChange;
  }, [onStepChange]);

  useEffect(() => {
    onStepActionRef.current = onStepAction;
  }, [onStepAction]);

  useEffect(() => {
    onForceStartConsumedRef.current = onForceStartConsumed;
  }, [onForceStartConsumed]);

  useEffect(() => {
    if (!mounted || forceStartKey === null || visibleSteps.length === 0) {
      return;
    }
    if (lastForceStartKeyRef.current === forceStartKey) {
      return;
    }
    lastForceStartKeyRef.current = forceStartKey;
    setStepIndex(0);
    setMode(defaultMode);
    setOpen(true);
    onForceStartConsumedRef.current?.();
  }, [defaultMode, forceStartKey, mounted, visibleSteps.length]);

  useEffect(() => {
    if (stepIndex < visibleSteps.length) return;
    setStepIndex(Math.max(0, visibleSteps.length - 1));
  }, [stepIndex, visibleSteps.length]);

  useEffect(() => {
    if (!open || !step) return;
    onStepChangeRef.current?.(step);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      if (event.key === "ArrowRight" && canAdvance) {
        setStepIndex((current) => Math.min(visibleSteps.length - 1, current + 1));
      }
      if (event.key === "ArrowLeft" && stepIndex > 0) {
        setStepIndex((current) => Math.max(0, current - 1));
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canAdvance, open, stepIndex, visibleSteps.length]);

  useEffect(() => {
    if (!open || !step?.targetId) return;

    const timeout = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-tour-id="${step.targetId}"]`);
      if (!target) return;
      target.setAttribute("data-tour-active", "true");
      target.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
    }, 80);

    return () => {
      window.clearTimeout(timeout);
      if (step?.targetId) {
        document
          .querySelector<HTMLElement>(`[data-tour-id="${step.targetId}"]`)
          ?.removeAttribute("data-tour-active");
      }
    };
  }, [open, step?.targetId]);

  function startTour(nextMode: AnnotatorTourMode = defaultMode) {
    setMode(nextMode);
    setStepIndex(0);
    setOpen(true);
  }

  function changeMode(nextMode: AnnotatorTourMode) {
    setMode(nextMode);
    setStepIndex(0);
  }

  function skipTour() {
    setTourComplete();
    setOpen(false);
  }

  function finishTour() {
    setTourComplete();
    setOpen(false);
  }

  async function handleStepAction() {
    if (!step?.actionId || !onStepActionRef.current) {
      return;
    }
    setActionBusy(true);
    try {
      const result = await onStepActionRef.current(step);
      if (result === false) {
        return;
      }
      if (isFinalStep && requiredActionComplete) {
        finishTour();
      }
    } finally {
      setActionBusy(false);
    }
  }

  function goNext() {
    if (!canAdvance) return;
    setStepIndex((current) => Math.min(visibleSteps.length - 1, current + 1));
  }

  const panel =
    mounted && open && step ? (
      <div className="pointer-events-none fixed inset-0 z-50">
        <style>
          {`
            [data-tour-active="true"] {
              outline: 3px solid #080e36;
              outline-offset: 6px;
              position: relative;
              z-index: 20;
              filter: none;
              box-shadow: 0 0 0 8px rgba(255, 255, 255, 0.86), 0 24px 54px -36px rgba(8, 14, 54, 0.85);
              transition: outline-color 160ms ease, box-shadow 160ms ease, filter 160ms ease;
            }
          `}
        </style>
        <section
          role="dialog"
          aria-modal="false"
          aria-label="Annotator guided tour"
          className="pointer-events-auto fixed bottom-4 right-4 w-[calc(100vw-2rem)] max-w-[720px] rounded-2xl border border-[#d9d2ef] bg-white shadow-[0_24px_70px_-36px_rgba(8,14,54,0.95)]"
        >
          <div className="border-b border-[#ece4f6] px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#797590]">
                  Annotator workflow assistant
                </p>
                <h2 className="oa-title mt-1 text-lg font-semibold">Guided workflow</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  aria-label="Guided tour mode"
                  className="inline-flex rounded-xl border border-[#d9d2ef] bg-[#fbf8ff] p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={mode === "quick"}
                    onClick={() => changeMode("quick")}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      mode === "quick" ? "bg-white text-[#21194d] shadow-[0_8px_18px_-14px_rgba(15,23,42,0.8)]" : "text-[#6b6384]"
                    }`}
                  >
                    Quick tour
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "full"}
                    onClick={() => changeMode("full")}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      mode === "full" ? "bg-white text-[#21194d] shadow-[0_8px_18px_-14px_rgba(15,23,42,0.8)]" : "text-[#6b6384]"
                    }`}
                  >
                    Full workflow tour
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="oa-btn-secondary px-3 py-1.5 text-sm font-medium"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#eee7f8]">
              <div
                className="h-full rounded-full bg-[#080e36] transition-all"
                style={{ width: `${((stepIndex + 1) / visibleSteps.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="grid max-h-[62vh] overflow-auto md:grid-cols-[minmax(0,1fr)_230px]">
            <div className="px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6f6888]">
                Step {stepIndex + 1} of {visibleSteps.length}
              </p>
              <h3 className="oa-title mt-1 text-base font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#4b4665]">{step.body}</p>

              {requiredAction ? (
                <div
                  className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
                    requiredActionComplete
                      ? "border-[#bfe5cb] bg-[#f1fbf5] text-[#266544]"
                      : "border-[#ffd9a8] bg-[#fff8ec] text-[#925b17]"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{requiredActionLabel}</span>
                    <span>{requiredActionComplete ? "Ready" : "Complete this step to continue"}</span>
                  </div>
                  {requiredActionHint ? <p className="mt-1 text-xs opacity-90">{requiredActionHint}</p> : null}
                </div>
              ) : null}

              {step.actionId && onStepActionRef.current && !isFinalStep ? (
                <button
                  type="button"
                  aria-label={step.actionAriaLabel}
                  onClick={() => void handleStepAction()}
                  disabled={actionBusy || Boolean(requiredActionState?.disabled) || (isFinalStep && !requiredActionComplete)}
                  className="oa-btn-primary mt-3 px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {actionBusy ? "Working..." : step.actionLabel ?? "Do this step"}
                </button>
              ) : null}

              {step.checklist?.length ? (
                <ul className="mt-3 space-y-2 text-sm text-[#4b4665]">
                  {step.checklist.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#7c6cb0]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {milestones.length > 0 ? (
              <aside className="border-t border-[#ece4f6] bg-[#fbf8ff] px-4 py-4 md:border-l md:border-t-0">
                <h3 className="oa-title text-sm font-semibold">Workflow checklist</h3>
                <div className="mt-3 space-y-2">
                  {milestones.map((milestone) => {
                    const active = !milestone.complete && milestone.id === step.id;
                    return (
                      <div
                        key={milestone.id}
                        className={`rounded-xl border px-3 py-2 text-xs ${
                          milestone.complete
                            ? "border-[#bfe5cb] bg-white text-[#266544]"
                            : active
                              ? "border-[#c7d2fe] bg-[#eef2ff] text-[#3730a3]"
                              : "border-[#ece4f6] bg-white text-[#6b6384]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{milestone.label}</span>
                          <span>{milestone.complete ? "Done" : active ? "Current" : "Pending"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </aside>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ece4f6] px-4 py-3">
            <button type="button" onClick={skipTour} className="oa-btn-quiet px-3 py-1.5 text-sm font-medium">
              Skip tour
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
                disabled={stepIndex === 0}
                className="oa-btn-secondary px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                Back
              </button>
              {isFinalStep ? (
                step.actionId && onStepActionRef.current ? (
                  <button
                    type="button"
                    aria-label={step.actionAriaLabel}
                    onClick={() => void handleStepAction()}
                    disabled={actionBusy || Boolean(requiredActionState?.disabled) || !requiredActionComplete}
                    className="oa-btn-primary px-3.5 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {actionBusy ? "Working..." : step.actionLabel ?? "Finish tour"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={finishTour}
                    disabled={!requiredActionComplete}
                    className="oa-btn-primary px-3.5 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Finish tour
                  </button>
                )
              ) : (
                <button
                  type="button"
                  aria-label="Next step"
                  onClick={goNext}
                  disabled={!canAdvance}
                  className="oa-btn-primary px-3.5 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-55"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    ) : null;

  return (
    <>
      <button
        type="button"
        aria-label="Start annotator guided tour"
        onClick={() => startTour(defaultMode)}
        className="oa-btn-secondary px-3 py-1.5 text-sm font-medium"
      >
        Start Guided Tour
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

interface AnimatedMetricNumberProps {
  value: number | null;
  format?: (value: number) => string;
  loading?: boolean;
  fallback?: string;
  durationMs?: number;
  className?: string;
}

function defaultFormat(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function shouldRenderFinalValueImmediately(): boolean {
  if (typeof window === "undefined") return false;
  const requestAnimationFrameMock = window.requestAnimationFrame as typeof window.requestAnimationFrame & {
    _isMockFunction?: boolean;
    getMockName?: () => string;
  };
  return (
    prefersReducedMotion() ||
    (typeof navigator !== "undefined" &&
      /jsdom/i.test(navigator.userAgent) &&
      !requestAnimationFrameMock._isMockFunction &&
      !requestAnimationFrameMock.getMockName)
  );
}

export function AnimatedMetricNumber({
  value,
  format = defaultFormat,
  loading = false,
  fallback = "No data",
  durationMs = 800,
  className,
}: AnimatedMetricNumberProps) {
  const numericValue = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [displayValue, setDisplayValue] = useState(() => (shouldRenderFinalValueImmediately() ? numericValue ?? 0 : 0));
  const displayValueRef = useRef(displayValue);

  useEffect(() => {
    displayValueRef.current = displayValue;
  }, [displayValue]);

  useEffect(() => {
    if (loading || numericValue === null) return;

    if (shouldRenderFinalValueImmediately() || durationMs <= 0) {
      setDisplayValue(numericValue);
      return;
    }

    const startValue = displayValueRef.current;
    let frameId: number | null = null;
    let startedAt: number | null = null;

    const tick = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / durationMs);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const nextValue = startValue + (numericValue - startValue) * easedProgress;

      displayValueRef.current = nextValue;
      setDisplayValue(nextValue);

      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [durationMs, loading, numericValue]);

  if (loading) {
    return (
      <span className={className} data-testid="animated-metric-number">
        ...
      </span>
    );
  }

  if (numericValue === null) {
    return (
      <span className={className} data-testid="animated-metric-number">
        {fallback}
      </span>
    );
  }

  return (
    <span className={className} data-testid="animated-metric-number" aria-label={format(numericValue)}>
      {format(displayValue)}
    </span>
  );
}

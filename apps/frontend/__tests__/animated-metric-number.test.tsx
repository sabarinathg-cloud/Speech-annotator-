import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnimatedMetricNumber } from "@/components/animated-metric-number";

describe("AnimatedMetricNumber", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("counts up to the formatted target instead of rendering the final number immediately", () => {
    render(<AnimatedMetricNumber value={16.7} format={(value) => `${value.toFixed(1)}%`} />);

    const number = screen.getByTestId("animated-metric-number");
    expect(number).toHaveTextContent("0.0%");

    act(() => {
      rafCallbacks.shift()?.(0);
      rafCallbacks.shift()?.(450);
    });
    expect(number).not.toHaveTextContent("16.7%");

    act(() => {
      rafCallbacks.shift()?.(900);
    });
    expect(number).toHaveTextContent("16.7%");
  });

  it("shows the final number immediately when reduced motion is requested", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);

    render(<AnimatedMetricNumber value={42} format={(value) => String(Math.round(value))} />);

    expect(screen.getByTestId("animated-metric-number")).toHaveTextContent("42");
  });
});

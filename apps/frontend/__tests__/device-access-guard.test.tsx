import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceAccessGuard, isSupportedLaptopBrowser } from "@/components/device-access-guard";

function setBrowserShape({ userAgent, width }: { userAgent: string; width: number }) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("DeviceAccessGuard", () => {
  afterEach(() => {
    cleanup();
    setBrowserShape({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      width: 1440,
    });
  });

  it("allows a laptop or desktop browser", async () => {
    setBrowserShape({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      width: 1440,
    });

    render(
      <DeviceAccessGuard>
        <div>Application workspace</div>
      </DeviceAccessGuard>
    );

    expect(await screen.findByText("Application workspace")).toBeInTheDocument();
    expect(screen.queryByText("Laptop required")).not.toBeInTheDocument();
  });

  it("blocks phones and tablets before rendering the application", async () => {
    setBrowserShape({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      width: 390,
    });

    render(
      <DeviceAccessGuard>
        <div>Application workspace</div>
      </DeviceAccessGuard>
    );

    await waitFor(() => expect(screen.getByText("Laptop required")).toBeInTheDocument());
    expect(screen.queryByText("Application workspace")).not.toBeInTheDocument();
  });

  it("requires a laptop-sized viewport even when the user agent is not mobile", () => {
    expect(
      isSupportedLaptopBrowser({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        viewportWidth: 480,
      })
    ).toBe(false);
  });
});

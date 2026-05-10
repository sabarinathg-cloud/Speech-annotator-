"use client";

import { useEffect, useState } from "react";

export const MIN_LAPTOP_VIEWPORT_WIDTH = 900;

const MOBILE_OR_TABLET_MARKERS = [
  "android",
  "bb10",
  "blackberry",
  "fennec",
  "ipad",
  "iphone",
  "ipod",
  "kindle",
  "mobile",
  "opera mini",
  "phone",
  "playbook",
  "silk/",
  "tablet",
  "windows phone",
];

const DESKTOP_MARKERS = ["cros", "linux x86_64", "linux i686", "macintosh", "windows nt", "x11"];

export function isSupportedLaptopBrowser({
  userAgent,
  viewportWidth,
}: {
  userAgent: string;
  viewportWidth: number;
}): boolean {
  const normalizedUserAgent = userAgent.toLowerCase();
  if (viewportWidth < MIN_LAPTOP_VIEWPORT_WIDTH) return false;
  if (MOBILE_OR_TABLET_MARKERS.some((marker) => normalizedUserAgent.includes(marker))) return false;
  return DESKTOP_MARKERS.some((marker) => normalizedUserAgent.includes(marker));
}

export function DeviceAccessGuard({ children }: { children: React.ReactNode }) {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);

  useEffect(() => {
    function checkDevice() {
      setIsSupported(
        isSupportedLaptopBrowser({
          userAgent: window.navigator.userAgent,
          viewportWidth: window.innerWidth,
        })
      );
    }

    checkDevice();
    window.addEventListener("resize", checkDevice);
    window.addEventListener("orientationchange", checkDevice);
    return () => {
      window.removeEventListener("resize", checkDevice);
      window.removeEventListener("orientationchange", checkDevice);
    };
  }, []);

  if (isSupported === false) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4 py-8">
        <section
          role="alert"
          aria-label="Unsupported device"
          className="oa-card w-full max-w-[560px] p-6 text-center sm:p-7"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c7895]">Secure Access</p>
          <h1 className="oa-title mt-2 text-2xl font-semibold">Laptop required</h1>
          <p className="mt-3 text-sm leading-6 text-[#5f5b79]">
            This annotation workspace contains sensitive data and is available only on laptop or desktop browsers.
            Please switch to an approved laptop to continue.
          </p>
        </section>
      </main>
    );
  }

  if (isSupported === null) {
    return (
      <main className="oa-page flex min-h-screen items-center justify-center px-4">
        <div className="oa-card px-5 py-4 text-sm text-[#5f5b79]">Checking device...</div>
      </main>
    );
  }

  return children;
}

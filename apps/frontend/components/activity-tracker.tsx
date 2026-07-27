"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { useAuth } from "@/components/auth-provider";
import { recordActivityHeartbeat } from "@/lib/api";

const HEARTBEAT_INTERVAL_MS = 15_000;
const IDLE_THRESHOLD_MS = 60_000;
const MAX_CLIENT_HEARTBEAT_SECONDS = 60;

export function ActivityTracker({ enabled }: { enabled: boolean }) {
  const { accessToken, activeOrganizationId } = useAuth();
  const pathname = usePathname();
  const lastUserActivityAt = useRef(Date.now());
  const lastSentAt = useRef(Date.now());
  const eventCount = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    lastUserActivityAt.current = Date.now();
    lastSentAt.current = Date.now();
    eventCount.current = 0;
  }, [activeOrganizationId, accessToken]);

  useEffect(() => {
    if (!enabled || !accessToken || !activeOrganizationId) return;

    const markActive = () => {
      lastUserActivityAt.current = Date.now();
      eventCount.current = Math.min(eventCount.current + 1, 10000);
    };
    const markVisible = () => {
      if (document.visibilityState === "visible") {
        markActive();
      }
    };
    const activityEvents = ["click", "keydown", "pointerdown", "mousemove", "scroll", "touchstart", "input"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, markActive, { passive: true }));
    document.addEventListener("visibilitychange", markVisible);

    return () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, markActive));
      document.removeEventListener("visibilitychange", markVisible);
    };
  }, [activeOrganizationId, accessToken, enabled]);

  useEffect(() => {
    if (!enabled || !accessToken || !activeOrganizationId) return;

    const intervalId = window.setInterval(() => {
      if (inFlight.current) return;

      const now = Date.now();
      const elapsedSeconds = Math.min(
        MAX_CLIENT_HEARTBEAT_SECONDS,
        Math.max(0, Math.round((now - lastSentAt.current) / 1000))
      );
      if (elapsedSeconds <= 0) return;

      const visible = document.visibilityState === "visible";
      const mediaPlaying = isAnyMediaPlaying();
      const recentlyActive = now - lastUserActivityAt.current <= IDLE_THRESHOLD_MS;
      const active = visible && (recentlyActive || mediaPlaying);
      const payload = {
        task_id: taskIdFromPathname(pathname),
        route: pathname,
        active_seconds: active ? elapsedSeconds : 0,
        idle_seconds: active ? 0 : elapsedSeconds,
        event_count: eventCount.current,
        started_at: new Date(now - elapsedSeconds * 1000).toISOString(),
        ended_at: new Date(now).toISOString(),
      };

      lastSentAt.current = now;
      eventCount.current = 0;
      inFlight.current = true;
      recordActivityHeartbeat(accessToken, payload)
        .catch(() => {
          // Tracking should never interrupt annotation work.
        })
        .finally(() => {
          inFlight.current = false;
        });
    }, HEARTBEAT_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [activeOrganizationId, accessToken, enabled, pathname]);

  return null;
}

function taskIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/tasks\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isAnyMediaPlaying(): boolean {
  return Array.from(document.querySelectorAll("audio, video")).some((element) => {
    const mediaElement = element as HTMLMediaElement;
    return !mediaElement.paused && !mediaElement.ended && mediaElement.readyState > 2;
  });
}

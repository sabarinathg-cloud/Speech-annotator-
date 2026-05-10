"use client";

import { useEffect, useRef, useState } from "react";

import { logClientSecurityEvent } from "@/lib/api";

type ClientSecurityAction =
  | "ATTEMPT_CONTEXT_MENU"
  | "ATTEMPT_COPY"
  | "ATTEMPT_DEVTOOLS"
  | "ATTEMPT_PRINT"
  | "ATTEMPT_SCREEN_CAPTURE"
  | "ATTEMPT_SAVE_PAGE"
  | "ATTEMPT_VIEW_SOURCE";

const WARNING_BY_ACTION: Record<ClientSecurityAction, string> = {
  ATTEMPT_CONTEXT_MENU: "Right click is disabled in this confidential workspace.",
  ATTEMPT_COPY: "Copying sensitive content is disabled and this attempt was logged.",
  ATTEMPT_DEVTOOLS: "Developer tools are not allowed in this confidential workspace.",
  ATTEMPT_PRINT: "Printing is disabled and this attempt was logged.",
  ATTEMPT_SCREEN_CAPTURE: "Screen capture attempts are not permitted and this attempt was logged.",
  ATTEMPT_SAVE_PAGE: "Saving this workspace locally is disabled and this attempt was logged.",
  ATTEMPT_VIEW_SOURCE: "Viewing source is disabled and this attempt was logged.",
};

function shortcutForEvent(event: KeyboardEvent): string {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Cmd");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join("+");
}

function securityActionForKey(event: KeyboardEvent): ClientSecurityAction | null {
  const key = event.key.toLowerCase();
  const hasCommand = event.ctrlKey || event.metaKey;

  if (event.key === "PrintScreen") return "ATTEMPT_SCREEN_CAPTURE";
  if (hasCommand && event.shiftKey && ["3", "4", "5"].includes(key)) return "ATTEMPT_SCREEN_CAPTURE";
  if (event.key === "F12") return "ATTEMPT_DEVTOOLS";
  if (hasCommand && key === "p") return "ATTEMPT_PRINT";
  if (hasCommand && key === "s") return "ATTEMPT_SAVE_PAGE";
  if (hasCommand && key === "u") return "ATTEMPT_VIEW_SOURCE";
  if (hasCommand && event.shiftKey && ["i", "j", "c"].includes(key)) return "ATTEMPT_DEVTOOLS";
  return null;
}

export function SecurityActivityGuard({ accessToken }: { accessToken: string | null }) {
  const [warning, setWarning] = useState<string | null>(null);
  const [privacyShieldVisible, setPrivacyShieldVisible] = useState(false);
  const clearWarningTimeout = useRef<number | null>(null);
  const clearPrivacyShieldTimeout = useRef<number | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const currentAccessToken = accessToken;

    function activatePrivacyShield(durationMs: number | null = 6000) {
      setPrivacyShieldVisible(true);
      if (clearPrivacyShieldTimeout.current !== null) {
        window.clearTimeout(clearPrivacyShieldTimeout.current);
      }
      if (durationMs !== null) {
        clearPrivacyShieldTimeout.current = window.setTimeout(() => setPrivacyShieldVisible(false), durationMs);
      }
    }

    function warnAndLog(
      action: ClientSecurityAction,
      metadata: Record<string, unknown> = {},
      options: { holdPrivacyShield?: boolean } = {}
    ) {
      if (action === "ATTEMPT_SCREEN_CAPTURE") {
        activatePrivacyShield(options.holdPrivacyShield ? null : 6000);
      }
      setWarning(WARNING_BY_ACTION[action]);
      if (clearWarningTimeout.current !== null) {
        window.clearTimeout(clearWarningTimeout.current);
      }
      clearWarningTimeout.current = window.setTimeout(() => setWarning(null), 4000);
      void logClientSecurityEvent(currentAccessToken, {
        action,
        metadata: {
          route: window.location.pathname,
          ...metadata,
        },
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      const action = securityActionForKey(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      warnAndLog(action, { shortcut: shortcutForEvent(event) });
    }

    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
      warnAndLog("ATTEMPT_CONTEXT_MENU");
    }

    function handleCopy(event: ClipboardEvent) {
      event.preventDefault();
      warnAndLog("ATTEMPT_COPY");
    }

    function handleBeforePrint(event: Event) {
      event.preventDefault();
      warnAndLog("ATTEMPT_PRINT", { trigger: "beforeprint" });
    }

    function handleWindowBlur() {
      warnAndLog("ATTEMPT_SCREEN_CAPTURE", { trigger: "window_blur" }, { holdPrivacyShield: true });
    }

    function handleWindowFocus() {
      if (clearPrivacyShieldTimeout.current !== null) {
        window.clearTimeout(clearPrivacyShieldTimeout.current);
      }
      clearPrivacyShieldTimeout.current = window.setTimeout(() => setPrivacyShieldVisible(false), 800);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        warnAndLog("ATTEMPT_SCREEN_CAPTURE", { trigger: "document_hidden" }, { holdPrivacyShield: true });
      } else {
        handleWindowFocus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("copy", handleCopy, true);
    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("copy", handleCopy, true);
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (clearWarningTimeout.current !== null) {
        window.clearTimeout(clearWarningTimeout.current);
      }
      if (clearPrivacyShieldTimeout.current !== null) {
        window.clearTimeout(clearPrivacyShieldTimeout.current);
      }
    };
  }, [accessToken]);

  if (!warning && !privacyShieldVisible) return null;

  return (
    <>
      {privacyShieldVisible ? (
        <div
          aria-label="Screen privacy shield"
          className="fixed inset-0 z-[75] flex items-center justify-center bg-black px-6 text-center text-white"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">
              Confidential Workspace
            </p>
            <p className="mt-2 text-2xl font-semibold">Screen protected</p>
          </div>
        </div>
      ) : null}
      {warning ? (
        <div
          role="alert"
          className="fixed right-4 top-4 z-[80] max-w-[380px] rounded-xl border border-[#f2c48b] bg-[#fff8ea] px-4 py-3 text-sm font-medium leading-5 text-[#6d4108] shadow-[0_18px_42px_-24px_rgba(77,45,10,0.55)]"
        >
          {warning}
        </div>
      ) : null}
    </>
  );
}

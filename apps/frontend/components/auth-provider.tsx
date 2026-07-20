"use client";

import type { User, UserOrganizationAccess } from "@outcomes/shared-types";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import {
  acknowledgeConfidentiality as acknowledgeConfidentialityRequest,
  fetchCurrentUser,
  login as loginRequest,
} from "@/lib/api";
import {
  SESSION_CHANGED_EVENT,
  clearSession,
  readSession,
  writeActiveOrganizationId,
  writeSession,
} from "@/lib/session";

export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_DEVICE_CHECK_INTERVAL_MS = 10 * 1000;

interface AuthContextValue {
  user: User | null;
  accessToken: string | null;
  activeOrganizationId: string | null;
  activeOrganization: UserOrganizationAccess | null;
  isLoading: boolean;
  setActiveOrganizationId: (organizationId: string) => void;
  login: (email: string, password: string) => Promise<User>;
  acknowledgeConfidentiality: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);

  useEffect(() => {
    function syncSession() {
      const session = readSession();
      setUser(session.user);
      setAccessToken(session.accessToken);
      setActiveOrganizationIdState(resolveActiveOrganizationId(session.user, session.activeOrganizationId));
    }
    syncSession();
    setIsLoading(false);
    window.addEventListener(SESSION_CHANGED_EVENT, syncSession);
    window.addEventListener("storage", syncSession);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, syncSession);
      window.removeEventListener("storage", syncSession);
    };
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    let timeoutId: number | null = null;
    const logoutForIdle = () => {
      clearSession();
      setUser(null);
      setAccessToken(null);
    };
    const resetIdleTimer = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(logoutForIdle, SESSION_IDLE_TIMEOUT_MS);
    };
    const activityEvents = ["click", "keydown", "mousemove", "scroll", "touchstart", "visibilitychange"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, resetIdleTimer, { passive: true }));
    resetIdleTimer();
    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, resetIdleTimer));
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    let checkInFlight = false;

    const endReplacedSession = () => {
      clearSession();
      setUser(null);
      setAccessToken(null);
    };

    const verifyActiveDevice = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        const currentUser = await fetchCurrentUser(accessToken);
        if (!cancelled) {
          setUser(currentUser);
          setActiveOrganizationIdState((current) => resolveActiveOrganizationId(currentUser, current));
        }
      } catch (error) {
        if (!cancelled && typeof error === "object" && error !== null && "status" in error && error.status === 401) {
          endReplacedSession();
        }
      } finally {
        checkInFlight = false;
      }
    };

    const verifyWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void verifyActiveDevice();
      }
    };

    const intervalId = window.setInterval(() => void verifyActiveDevice(), SESSION_DEVICE_CHECK_INTERVAL_MS);
    window.addEventListener("focus", verifyActiveDevice);
    document.addEventListener("visibilitychange", verifyWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", verifyActiveDevice);
      document.removeEventListener("visibilitychange", verifyWhenVisible);
    };
  }, [accessToken]);

  const activeOrganization = useMemo<UserOrganizationAccess | null>(() => {
    if (!user || !activeOrganizationId) return null;
    return (user.organizations ?? []).find((organization) => organization.id === activeOrganizationId) ?? null;
  }, [activeOrganizationId, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      activeOrganizationId,
      activeOrganization,
      isLoading,
      setActiveOrganizationId: (organizationId: string) => {
        writeActiveOrganizationId(organizationId);
        setActiveOrganizationIdState(organizationId);
      },
      login: async (email: string, password: string) => {
        const data = await loginRequest(email, password);
        writeSession(data.access_token, data.refresh_token, data.user);
        setUser(data.user);
        setAccessToken(data.access_token);
        setActiveOrganizationIdState(resolveActiveOrganizationId(data.user, null));
        return data.user;
      },
      acknowledgeConfidentiality: async () => {
        if (!accessToken) return;
        const data = await acknowledgeConfidentialityRequest(accessToken);
        writeSession(data.access_token, data.refresh_token, data.user);
        setUser(data.user);
        setAccessToken(data.access_token);
        setActiveOrganizationIdState((current) => resolveActiveOrganizationId(data.user, current));
      },
      logout: () => {
        clearSession();
        setUser(null);
        setAccessToken(null);
        setActiveOrganizationIdState(null);
      }
    }),
    [user, accessToken, activeOrganization, activeOrganizationId, isLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function resolveActiveOrganizationId(user: User | null, current: string | null): string | null {
  const activeOrganizations = (user?.organizations ?? []).filter((organization) => organization.is_active);
  if (activeOrganizations.length === 0) return null;
  if (current && activeOrganizations.some((organization) => organization.id === current)) return current;
  return user?.default_organization_id && activeOrganizations.some((organization) => organization.id === user.default_organization_id)
    ? user.default_organization_id
    : activeOrganizations[0].id;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

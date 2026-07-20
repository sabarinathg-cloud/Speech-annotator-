import type { User } from "@outcomes/shared-types";

const ACCESS_TOKEN_KEY = "outcomes_ai_access_token";
const REFRESH_TOKEN_KEY = "outcomes_ai_refresh_token";
const USER_KEY = "outcomes_ai_user";
const ACTIVE_ORGANIZATION_KEY = "outcomes_ai_active_organization_id";
export const SESSION_CHANGED_EVENT = "outcomes_ai_session_changed";

export interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  activeOrganizationId: string | null;
}

export function readSession(): SessionState {
  if (typeof window === "undefined") {
    return { accessToken: null, refreshToken: null, user: null, activeOrganizationId: null };
  }
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  const activeOrganizationId = localStorage.getItem(ACTIVE_ORGANIZATION_KEY);
  let user: User | null = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as User;
    } catch {
      user = null;
    }
  }
  return { accessToken, refreshToken, user, activeOrganizationId };
}

export function writeSession(accessToken: string, refreshToken: string, user: User): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  reconcileActiveOrganization(user);
  notifySessionChanged();
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
  notifySessionChanged();
}

export function readActiveOrganizationId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_ORGANIZATION_KEY);
}

export function writeActiveOrganizationId(organizationId: string | null): void {
  if (typeof window === "undefined") return;
  if (organizationId) {
    localStorage.setItem(ACTIVE_ORGANIZATION_KEY, organizationId);
  } else {
    localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
  }
  notifySessionChanged();
}

export function notifySessionChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

function reconcileActiveOrganization(user: User): void {
  if (typeof window === "undefined") return;
  const activeOrganizations = (user.organizations ?? []).filter((organization) => organization.is_active);
  if (activeOrganizations.length === 0) {
    localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
    return;
  }
  const current = localStorage.getItem(ACTIVE_ORGANIZATION_KEY);
  if (current && activeOrganizations.some((organization) => organization.id === current)) {
    return;
  }
  localStorage.setItem(
    ACTIVE_ORGANIZATION_KEY,
    user.default_organization_id && activeOrganizations.some((organization) => organization.id === user.default_organization_id)
      ? user.default_organization_id
      : activeOrganizations[0].id
  );
}

type PublicRuntimeEnv = {
  NEXT_PUBLIC_API_URL?: string;
  NODE_ENV?: string;
};

const LOCAL_API_BASE_URL = "http://localhost:8000/api/v1";
const BUILD_TIME_API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;
const BUILD_TIME_NODE_ENV = process.env.NODE_ENV;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveApiBaseUrl(env?: PublicRuntimeEnv): string {
  const configuredUrl = (env?.NEXT_PUBLIC_API_URL ?? BUILD_TIME_API_BASE_URL)?.trim();
  if (configuredUrl) {
    return trimTrailingSlashes(configuredUrl);
  }

  if ((env?.NODE_ENV ?? BUILD_TIME_NODE_ENV) === "production") {
    throw new Error("NEXT_PUBLIC_API_URL is required in production");
  }

  return LOCAL_API_BASE_URL;
}

export function resolveBackendOrigin(env?: PublicRuntimeEnv): string {
  return resolveApiBaseUrl(env).replace(/\/api\/v1$/, "");
}

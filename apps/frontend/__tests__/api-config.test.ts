import { describe, expect, it } from "vitest";

import { resolveApiBaseUrl, resolveBackendOrigin } from "@/lib/api-config";

describe("API runtime configuration", () => {
  it("normalizes configured API URLs", () => {
    expect(
      resolveApiBaseUrl({
        NEXT_PUBLIC_API_URL: "https://api.example.com/api/v1/",
        NODE_ENV: "production",
      })
    ).toBe("https://api.example.com/api/v1");
  });

  it("rejects missing API URLs in production", () => {
    expect(() => resolveApiBaseUrl({ NODE_ENV: "production" })).toThrow(
      "NEXT_PUBLIC_API_URL is required in production"
    );
  });

  it("keeps the localhost fallback for local development and tests", () => {
    expect(resolveApiBaseUrl({ NODE_ENV: "test" })).toBe("http://localhost:8000/api/v1");
  });

  it("derives the backend origin from the API base URL", () => {
    expect(
      resolveBackendOrigin({
        NEXT_PUBLIC_API_URL: "https://api.example.com/api/v1",
        NODE_ENV: "production",
      })
    ).toBe("https://api.example.com");
  });
});

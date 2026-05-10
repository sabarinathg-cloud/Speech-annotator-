import { describe, expect, it } from "vitest";

import { detectPIIAnnotations } from "@/lib/pii";

describe("fallback PII detection", () => {
  it("detects numeric account and address spans for masking fallback", () => {
    const annotations = detectPIIAnnotations(
      "Please update account 4829 at 118 Market Street."
    );
    const byLabel = Object.fromEntries(annotations.map((annotation) => [annotation.label, annotation]));

    expect(byLabel.ACCOUNT_NUMBER.value).toBe("4829");
    expect(byLabel.ADDRESS.value).toBe("118 Market Street");
  });
});

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

  it("detects context names and locations without terminal punctuation", () => {
    const annotations = detectPIIAnnotations(
      "The Spanish note says Maria Lopez lives near Plaza Mayor in Madrid."
    );
    const valuesByLabel = annotations.reduce<Record<string, string[]>>((grouped, annotation) => {
      grouped[annotation.label] = [...(grouped[annotation.label] ?? []), annotation.value];
      return grouped;
    }, {});

    expect(valuesByLabel.PERSON).toContain("Maria Lopez");
    expect(valuesByLabel.LOCATION).toContain("Plaza Mayor");
    expect(valuesByLabel.LOCATION).toContain("Madrid");
  });
});

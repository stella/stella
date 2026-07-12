import { describe, expect, test } from "bun:test";

import { normalizeSaosDumpItem } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";

describe("Polish court dump normalization", () => {
  test("preserves a valid payload", () => {
    const item = normalizeSaosDumpItem({
      id: 42,
      courtCases: [{ caseNumber: "I ACa 1/24" }],
      division: { id: 1, name: "Civil", court: { name: "Court" } },
      judges: [{ name: "Ada", specialRoles: ["presiding"] }],
      keywords: ["contract"],
      referencedCourtCases: [
        { caseNumber: "II CSK 2/23", judgmentIds: [2], generated: false },
      ],
    });

    expect(item).toMatchObject({
      id: 42,
      courtCases: [{ caseNumber: "I ACa 1/24" }],
      division: { id: 1, name: "Civil", court: { name: "Court" } },
      judges: [{ name: "Ada", specialRoles: ["presiding"] }],
      keywords: ["contract"],
    });
  }, 30_000);

  test("drops malformed optional fields without rejecting valid siblings", () => {
    const item = normalizeSaosDumpItem({
      id: 42,
      courtCases: { caseNumber: "wrong container" },
      judges: [{ name: 123 }],
      keywords: ["valid", 123],
      source: { judgmentUrl: 123 },
      textContent: "still usable",
    });

    expect(item.id).toBe(42);
    expect(item.textContent).toBe("still usable");
    expect(item.courtCases).toBeUndefined();
    expect(item.judges).toBeUndefined();
    expect(item.keywords).toBeUndefined();
    expect(item.source).toBeUndefined();
  });
});

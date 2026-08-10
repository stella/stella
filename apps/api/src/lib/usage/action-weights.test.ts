import { describe, expect, test } from "bun:test";

import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";

describe("computeUsageUnitCost", () => {
  test("non-BYOK action floors at 1 unit even if math rounds below", () => {
    // chat × flex × non-byok = 1 × 1 × 1 = 1 (already integer)
    expect(
      computeUsageUnitCost({
        actionType: "chat",
        serviceTier: "flex",
        isByok: false,
      }),
    ).toBe(1);
  });

  test("standard tier multiplies by 1.5 and rounds up", () => {
    // doc_review × standard × non-byok = 5 × 1.5 = 7.5 → ceil 8
    expect(
      computeUsageUnitCost({
        actionType: "doc_review",
        serviceTier: "standard",
        isByok: false,
      }),
    ).toBe(8);
  });

  test("BYOK consumes zero units regardless of action", () => {
    for (const actionType of [
      "chat",
      "anonymise",
      "doc_review",
      "case_law",
    ] as const) {
      expect(
        computeUsageUnitCost({
          actionType,
          serviceTier: "flex",
          isByok: true,
        }),
      ).toBe(0);
    }
  });
});

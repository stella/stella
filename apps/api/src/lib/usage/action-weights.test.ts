import { describe, expect, test } from "bun:test";

import {
  ACTION_WEIGHTS,
  BYOK_MULTIPLIER,
  computeUsageUnitCost,
  SERVICE_TIER_MULTIPLIERS,
} from "@/api/lib/usage/action-weights";

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

  test("BYOK multiplier is the single attribution switch", () => {
    // Belt-and-braces: if this changes, BYOK usage attribution is
    // changing and should be reviewed explicitly.
    expect(BYOK_MULTIPLIER).toBe(0);
  });

  test("standard tier multiplier is 1.5×, flex and batch are 1×", () => {
    expect(SERVICE_TIER_MULTIPLIERS.standard).toBe(1.5);
    expect(SERVICE_TIER_MULTIPLIERS.flex).toBe(1);
    expect(SERVICE_TIER_MULTIPLIERS.batch).toBe(1);
  });

  test("action weights reflect the public tier semantics", () => {
    expect(ACTION_WEIGHTS.chat).toBe(1);
    expect(ACTION_WEIGHTS.anonymise).toBe(3);
    expect(ACTION_WEIGHTS.doc_review).toBe(5);
    expect(ACTION_WEIGHTS.case_law).toBe(8);
  });
});

import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("review-decision-map-owner", () => {
  test("reports a Record from statuses to ReviewDecision", async () => {
    expect(
      await lintSingleRule(
        "review-decision-map-owner",
        'import type { ReviewDecision } from "@stll/api-contract/review-decision";\nexport const A = { open: null } as const satisfies Record<"open", ReviewDecision | null>;\nexport type B = Record<"done", ReviewDecision>;',
        { sourcePath: "source.ts" },
      ),
    ).toEqual([2, 3]);
  });
  test("accepts reading the owner and records of other values", async () => {
    expect(
      await lintSingleRule(
        "review-decision-map-owner",
        'import { REVIEW_STATUS_DECISION } from "@stll/api-contract/review-decision";\nexport const read = REVIEW_STATUS_DECISION.finding.accepted;\nexport type C = Record<"a", string>;',
        { sourcePath: "source.ts" },
      ),
    ).toEqual([]);
  });
});

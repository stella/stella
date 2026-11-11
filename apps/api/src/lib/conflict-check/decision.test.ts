import { describe, expect, test } from "bun:test";

import { CONFLICT_CHECK_REFUSAL_CODE } from "@stll/api-contract/conflict-checks";
import type { ConflictCheckDecisionInput } from "@stll/api-contract/conflict-checks";

import { decisionRefusal } from "./decision";

const refusal = (
  input: ConflictCheckDecisionInput,
  outcome: Parameters<typeof decisionRefusal>[0]["outcome"],
  isReviewer: boolean,
) => {
  const result = decisionRefusal({ input, outcome, isReviewer });
  return result.isErr() ? (result.error.code ?? "error") : null;
};

describe("conflict check decisions", () => {
  test("the runner records a conflict, or clears a complete check without a potential conflict", () => {
    for (const outcome of [
      "needs_review",
      "information_only",
      "no_matches",
    ] as const) {
      expect(
        refusal(
          { decision: "cleared", expectedDecision: "pending" },
          outcome,
          false,
        ),
      ).toBeNull();
    }
    expect(
      refusal(
        { decision: "conflict", expectedDecision: "pending" },
        "potential_conflict",
        false,
      ),
    ).toBeNull();
  });

  test("clearing a potential conflict or an incomplete check takes a reviewer and a note", () => {
    for (const outcome of ["potential_conflict", "incomplete"] as const) {
      expect(
        refusal(
          { decision: "cleared", expectedDecision: "pending", note: "ok" },
          outcome,
          false,
        ),
      ).toBe(CONFLICT_CHECK_REFUSAL_CODE.reviewRequired);
      expect(
        refusal(
          { decision: "cleared", expectedDecision: "pending" },
          outcome,
          true,
        ),
      ).toBe("validation_error");
      expect(
        refusal(
          {
            decision: "cleared",
            expectedDecision: "pending",
            note: "Different matter",
          },
          outcome,
          true,
        ),
      ).toBeNull();
    }
  });

  test("a waiver takes a reviewer, a consent reference and a note", () => {
    const waiver = {
      decision: "waived",
      expectedDecision: "conflict",
      note: "Both clients consented",
      consentReference: "Letter of 3 November",
    } as const;
    expect(refusal(waiver, "potential_conflict", false)).toBe(
      CONFLICT_CHECK_REFUSAL_CODE.reviewRequired,
    );
    expect(refusal(waiver, "potential_conflict", true)).toBeNull();
    expect(
      refusal(
        { decision: "waived", expectedDecision: "conflict", note: "x" },
        "potential_conflict",
        true,
      ),
    ).toBe("validation_error");
  });

  test("only a waiver carries a consent reference, and replacing a decision needs a note", () => {
    expect(
      refusal(
        {
          decision: "conflict",
          expectedDecision: "pending",
          consentReference: "x",
        },
        "needs_review",
        true,
      ),
    ).toBe("validation_error");
    expect(
      refusal(
        { decision: "conflict", expectedDecision: "cleared" },
        "needs_review",
        true,
      ),
    ).toBe("validation_error");
    expect(
      refusal(
        { decision: "cleared", expectedDecision: "cleared", note: "again" },
        "needs_review",
        true,
      ),
    ).toBe("validation_error");
  });
});

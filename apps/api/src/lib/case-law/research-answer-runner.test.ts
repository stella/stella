import { describe, expect, test } from "bun:test";

import { selectDecisionPassages } from "@/api/lib/case-law/research-answer-runner";

describe("selectDecisionPassages", () => {
  test("does not mark the over-budget fallback as retrieved when search has no hits", () => {
    const passages = [{ anchorId: "b1", excerpt: "The fallback passage." }];

    expect(
      selectDecisionPassages({
        fallback: passages,
        retrieved: [],
        budgetChars: 100,
      }),
    ).toEqual({ kind: "passages", passages, retrieved: false });
  });

  test("marks passages as retrieved only when the index supplied them", () => {
    const retrieved = [{ anchorId: "b2", excerpt: "A ranked passage." }];

    expect(
      selectDecisionPassages({
        fallback: [{ anchorId: "b1", excerpt: "The full text." }],
        retrieved,
        budgetChars: 100,
      }),
    ).toEqual({ kind: "passages", passages: retrieved, retrieved: true });
  });
});

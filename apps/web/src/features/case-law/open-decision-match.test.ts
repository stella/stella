import { describe, expect, test } from "bun:test";

import type { DecisionIdentityResolution } from "@stll/api-contract/decision-query-intent";

import { decisionMatchToOpen } from "@/features/case-law/open-decision-match";

type Hit = { readonly id: string };

const first: Hit = { id: "first" };
const second: Hit = { id: "second" };

describe("decisionMatchToOpen", () => {
  test("a unique match opens without a note", () => {
    for (const basis of ["identifier", "selector", "docket"] as const) {
      expect(
        decisionMatchToOpen<Hit>({ basis, decision: first, status: "unique" }),
      ).toEqual({ decision: first, fileMayHoldOthers: false });
    }
  });

  test("one decision found in a file that may hold more opens with the note", () => {
    expect(
      decisionMatchToOpen<Hit>({
        candidates: [first],
        reason: "file_incomplete",
        status: "ambiguous",
      }),
    ).toEqual({ decision: first, fileMayHoldOthers: true });
  });

  test("several candidates, or a selector nobody carries, stay with the list", () => {
    const stays: DecisionIdentityResolution<Hit>[] = [
      { status: "none" },
      {
        candidates: [first, second],
        reason: "file_incomplete",
        status: "ambiguous",
      },
      { candidates: [], reason: "file_incomplete", status: "ambiguous" },
      { candidates: [first, second], reason: "several", status: "ambiguous" },
      { candidates: [first], reason: "several", status: "ambiguous" },
      {
        candidates: [first],
        reason: "selector_unmatched",
        status: "ambiguous",
      },
    ];
    for (const resolution of stays) {
      expect(decisionMatchToOpen(resolution)).toBeUndefined();
    }
  });
});

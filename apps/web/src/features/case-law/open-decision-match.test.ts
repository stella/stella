import { describe, expect, test } from "bun:test";

import type { DecisionIdentityResolution } from "@stll/api-contract/decision-query-intent";
import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  createDecisionFiltersFromSearch,
  decisionMatchToOpen,
} from "@/features/case-law/open-decision-match";
import { toSafeId } from "@/lib/safe-id";

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
        missing: ["sheet"],
        status: "incomplete_identifier",
      }),
    ).toEqual({ decision: first, fileMayHoldOthers: true });
  });

  test("several candidates, or a selector nobody carries, stay with the list", () => {
    const stays: DecisionIdentityResolution<Hit>[] = [
      { status: "none" },
      {
        candidates: [first, second],
        missing: ["sheet"],
        status: "incomplete_identifier",
      },
      { candidates: [], missing: ["sheet"], status: "incomplete_identifier" },
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

test("the selected source narrows both browse and ranked decision requests", () => {
  const sourceId = toSafeId<"caseLawSource">(
    "0194d94a-1122-7000-8000-123456789abc",
  );
  for (const q of [undefined, "nájem"]) {
    expect(
      createDecisionFiltersFromSearch(
        { country: "cz", sourceId, q },
        { excerpt: DEFAULT_SEARCH_EXCERPT },
      ),
    ).toEqual({
      country: "CZ",
      sourceId,
      excerpt: DEFAULT_SEARCH_EXCERPT,
      ...(q === undefined ? {} : { search: q, sort: "relevance" }),
    });
  }
});

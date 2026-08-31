/**
 * `normalizeParties` here is a standalone copy of the reference proposal
 * pass's normalizer (see the module docstring in `parties.ts`); this pins the
 * two copies to the same behaviour so a change to one that is not mirrored to
 * the other is caught here rather than at review time.
 */

import { describe, expect, test } from "bun:test";

import { REVIEW_PARTIES_MAX } from "@/api/lib/document-review/contract";

import { normalizeParties } from "./parties";

describe("normalizeParties", () => {
  test("trims whitespace and omits entries without a role", () => {
    expect(
      normalizeParties([
        { role: "  Purchaser  ", name: "  Example Holdings a.s.  " },
        { role: " Seller ", name: "   " },
        { role: "   ", name: "Ignored Entity" },
      ]),
    ).toEqual([
      { role: "Purchaser", name: "Example Holdings a.s." },
      { role: "Seller", name: null },
    ]);
  });

  test("caps normalized parties at the review limit", () => {
    const normalized = normalizeParties(
      Array.from({ length: REVIEW_PARTIES_MAX + 2 }, (_, index) => ({
        role: `Party ${String(index + 1)}`,
        name: null,
      })),
    );

    expect(normalized).toHaveLength(REVIEW_PARTIES_MAX);
    expect(normalized.at(-1)?.role).toBe(`Party ${String(REVIEW_PARTIES_MAX)}`);
  });

  test("treats a blank name the same as no name", () => {
    expect(normalizeParties([{ role: "Landlord", name: "   " }])).toEqual([
      { role: "Landlord", name: null },
    ]);
  });
});

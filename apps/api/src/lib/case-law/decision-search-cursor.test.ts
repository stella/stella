import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import type { DecisionDatePosition } from "@/api/lib/case-law/decision-date-order";
import {
  decodeDecisionSearchCursor,
  encodeDecisionSearchCursor,
} from "@/api/lib/case-law/decision-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { encodeCursor } from "@/api/lib/search/cursor";

const DECISION_ID = "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a";
const decisionId = toSafeId<"caseLawDecision">(DECISION_ID);

test("a relevance cursor round-trips its score", () => {
  fc.assert(
    fc.property(
      fc
        .double({ noDefaultInfinity: true, noNaN: true })
        // -0 is excluded because String(-0) === "0" loses the sign.
        .filter((sortKey) => !Object.is(sortKey, -0)),
      (sortKey) => {
        const cursor = { sort: "relevance", sortKey, id: DECISION_ID } as const;
        expect(
          decodeDecisionSearchCursor(
            encodeDecisionSearchCursor(cursor),
            "relevance",
          ),
        ).toEqual(cursor);
      },
    ),
    propertyConfig(),
  );
});

const datedPosition = fc
  .date({
    min: new Date("1000-01-01T00:00:00Z"),
    max: new Date("2999-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((date): DecisionDatePosition => ({
    band: "dated",
    decisionDate: date.toISOString().slice(0, 10),
    id: decisionId,
  }));

test("a newest cursor round-trips its position in either band", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        datedPosition,
        fc.constant<DecisionDatePosition>({ band: "undated", id: decisionId }),
      ),
      (position) => {
        expect(
          decodeDecisionSearchCursor(
            encodeDecisionSearchCursor({ sort: "newest", position }),
            "newest",
          ),
        ).toEqual({ sort: "newest", position });
      },
    ),
    propertyConfig(),
  );
});

// A boundary in one order bounds nothing in the other: continuing it would
// skip and repeat decisions behind an ordinary-looking page.
test("a cursor is read only by the order that issued it", () => {
  const issued = {
    relevance: encodeDecisionSearchCursor({
      sort: "relevance",
      sortKey: 0.5,
      id: DECISION_ID,
    }),
    newest: encodeDecisionSearchCursor({
      sort: "newest",
      position: { band: "dated", decisionDate: "2024-03-05", id: decisionId },
    }),
  };
  for (const issuer of SEARCH_SORTS) {
    for (const reader of SEARCH_SORTS) {
      expect(decodeDecisionSearchCursor(issued[issuer], reader) !== null).toBe(
        issuer === reader,
      );
    }
  }
});

// The form issued before the order travelled: relevance is the only order a
// replica issuing it could have ranked its page in.
test("reads a cursor from before the order field as a relevance page", () => {
  expect(
    decodeDecisionSearchCursor(encodeCursor(0.25, DECISION_ID), "relevance"),
  ).toEqual({ id: DECISION_ID, sort: "relevance", sortKey: 0.25 });
});

test.each([
  // An order this service does not declare is not one it ranked a page in.
  `oldest:${DECISION_ID}`,
  `newest:${DECISION_ID}`,
  `relevance:extra:${DECISION_ID}`,
  // Not a decision this service can page from.
  "relevance:not-a-uuid",
  "relevance:",
])(
  "rejects the malformed relevance payload %p rather than guessing",
  (payload) => {
    expect(
      decodeDecisionSearchCursor(encodeCursor(0.5, payload), "relevance"),
    ).toBeNull();
  },
);

test.each([
  ["a key that is not a calendar date", ["newest", 1_700_000_000, DECISION_ID]],
  ["an impossible date", ["newest", "2024-13-45", DECISION_ID]],
  ["another scope", ["oldest", "2024-03-05", DECISION_ID]],
  ["a decision this service cannot page from", ["newest", null, "x"]],
] as const)("rejects a newest cursor with %s", (_reason, parts) => {
  expect(
    decodeDecisionSearchCursor(encodePaginationCursor(parts), "newest"),
  ).toBeNull();
});

test("decode is total — never throws on arbitrary strings", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.constantFrom(...SEARCH_SORTS),
      (input, sort) => {
        expect(() => decodeDecisionSearchCursor(input, sort)).not.toThrow();
      },
    ),
    propertyConfig(),
  );
});

import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  decodeDecisionSearchCursor,
  encodeDecisionSearchCursor,
} from "@/api/lib/case-law/decision-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
import { encodeCursor } from "@/api/lib/search/cursor";

const DECISION_ID = "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a";

test("a cursor round-trips its key and the order that produced it", () => {
  fc.assert(
    fc.property(
      fc
        .double({ noDefaultInfinity: true, noNaN: true })
        // -0 is excluded because String(-0) === "0" loses the sign.
        .filter((sortKey) => !Object.is(sortKey, -0)),
      fc.constantFrom(...SEARCH_SORTS),
      (sortKey, sort) => {
        expect(
          decodeDecisionSearchCursor(
            encodeDecisionSearchCursor({ id: DECISION_ID, sort, sortKey }),
          ),
        ).toEqual({ id: DECISION_ID, sort, sortKey });
      },
    ),
    propertyConfig(),
  );
});

// A date key read as a relevance score would page a blended ranking from a
// boundary in seconds since the epoch, which no page of it can satisfy.
test("a cursor names the order its key belongs to", () => {
  const newest = decodeDecisionSearchCursor(
    encodeDecisionSearchCursor({
      id: DECISION_ID,
      sort: "newest",
      sortKey: 1_700_000_000,
    }),
  );

  expect(newest?.sort).toBe("newest");
  expect(newest?.sortKey).toBe(1_700_000_000);
});

// The form issued before the order travelled: relevance is the only order a
// replica issuing it could have ranked its page in.
test("reads a cursor from before the order field as a relevance page", () => {
  expect(decodeDecisionSearchCursor(encodeCursor(0.25, DECISION_ID))).toEqual({
    id: DECISION_ID,
    sort: "relevance",
    sortKey: 0.25,
  });
});

test.each([
  // An order this service does not declare is not one it ranked a page in.
  `oldest:${DECISION_ID}`,
  `relevance:extra:${DECISION_ID}`,
  // Not a decision this service can page from.
  "newest:not-a-uuid",
  "newest:",
])("rejects the malformed payload %p rather than guessing", (payload) => {
  expect(decodeDecisionSearchCursor(encodeCursor(0.5, payload))).toBeNull();
});

test("decode is total — never throws on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      expect(() => decodeDecisionSearchCursor(input)).not.toThrow();
    }),
    propertyConfig(),
  );
});

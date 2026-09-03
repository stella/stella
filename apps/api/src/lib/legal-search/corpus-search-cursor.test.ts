import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  type ExpansionDictionaryIdentity,
  NO_EXPANSION_DICTIONARY_IDENTITY,
} from "@/api/lib/legal-search/morphology/dictionary";
import { encodeCursor } from "@/api/lib/search/cursor";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DICTIONARY_A: ExpansionDictionaryIdentity = {
  contentHash: HASH_A,
  type: "dictionary",
};
const DICTIONARY_B: ExpansionDictionaryIdentity = {
  contentHash: HASH_B,
  type: "dictionary",
};
const DECISION_ID = "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a";

test("a cursor round-trips the window and the dictionary that built its page", () => {
  const cursor = {
    dictionary: DICTIONARY_A,
    id: DECISION_ID,
    score: 0.875,
    windowStart: 900,
  };

  expect(decodeCorpusSearchCursor(encodeCorpusSearchCursor(cursor))).toEqual(
    cursor,
  );
});

// A query nothing was expanded against pages against itself, whatever made it
// unexpanded: mode `off`, mode `shadow`, a jurisdiction with no dictionary.
test("an unexpanded page round-trips the no-dictionary identity", () => {
  const cursor = encodeCorpusSearchCursor({
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    id: DECISION_ID,
    score: 0.5,
    windowStart: 0,
  });

  expect(decodeCorpusSearchCursor(cursor)?.dictionary).toEqual(
    NO_EXPANSION_DICTIONARY_IDENTITY,
  );
  expect(
    isStaleCorpusSearchCursor(
      decodeCorpusSearchCursor(cursor),
      NO_EXPANSION_DICTIONARY_IDENTITY,
    ),
  ).toBe(false);
});

test("a cursor continues only against the dictionary it names", () => {
  const cursor = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor({
      dictionary: DICTIONARY_A,
      id: DECISION_ID,
      score: 0.4,
      windowStart: 12,
    }),
  );

  expect(isStaleCorpusSearchCursor(cursor, DICTIONARY_A)).toBe(false);
  expect(isStaleCorpusSearchCursor(cursor, DICTIONARY_B)).toBe(true);
  // A rebuilt or unreachable dictionary is not the one that ranked page 1.
  expect(
    isStaleCorpusSearchCursor(cursor, NO_EXPANSION_DICTIONARY_IDENTITY),
  ).toBe(true);
});

// The other direction of the same rule: a page that expanded nothing must not
// be continued against a dictionary that would rank a different result set.
test("an unexpanded cursor does not continue into an expanded query", () => {
  const cursor = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor({
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      id: DECISION_ID,
      score: 0.4,
      windowStart: 0,
    }),
  );

  expect(isStaleCorpusSearchCursor(cursor, DICTIONARY_A)).toBe(true);
});

test("a first page is never stale", () => {
  expect(isStaleCorpusSearchCursor(null, DICTIONARY_A)).toBe(false);
  expect(
    isStaleCorpusSearchCursor(null, NO_EXPANSION_DICTIONARY_IDENTITY),
  ).toBe(false);
});

// Both legacy forms a rolling deploy can hand back. Neither could have been
// issued by a replica that ran the expanded query, so `none` is what their
// page was built with; the window is what the older format says it is.
test("reads a cursor from before the window field as the first window", () => {
  expect(decodeCorpusSearchCursor(encodeCursor(0.25, DECISION_ID))).toEqual({
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    id: DECISION_ID,
    score: 0.25,
    windowStart: 0,
  });
});

test("reads a cursor from before the dictionary field in its own window", () => {
  expect(
    decodeCorpusSearchCursor(encodeCursor(0.5, `900:${DECISION_ID}`)),
  ).toEqual({
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    id: DECISION_ID,
    score: 0.5,
    windowStart: 900,
  });
});

// The legacy readers admit a missing field, never a wrong one.
test("a legacy cursor is not a way past the identity check", () => {
  expect(
    isStaleCorpusSearchCursor(
      decodeCorpusSearchCursor(encodeCursor(0.25, `900:${DECISION_ID}`)),
      DICTIONARY_A,
    ),
  ).toBe(true);
});

test.each([
  // One metadata segment is a window rank and nothing else.
  `garbage:${DECISION_ID}`,
  `-3:${DECISION_ID}`,
  `1.5:${DECISION_ID}`,
  `${HASH_A}:${DECISION_ID}`,
  `none:${DECISION_ID}`,
  // A rank no scan could have reached is not one this service issued.
  `${"9".repeat(11)}:${DECISION_ID}`,
  // Well-shaped segments in the wrong order, or one too many.
  `${HASH_A}:900:${DECISION_ID}`,
  `900:none-ish:${DECISION_ID}`,
  `900:${HASH_A.slice(0, 63)}:${DECISION_ID}`,
  `900:none:extra:${DECISION_ID}`,
  // Nothing left to page from.
  "900:",
  `900:${HASH_A}:`,
])("rejects the malformed payload %p rather than guessing", (payload) => {
  expect(decodeCorpusSearchCursor(encodeCursor(0.5, payload))).toBeNull();
});

test("decode is total — never throws on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      expect(() => decodeCorpusSearchCursor(input)).not.toThrow();
    }),
    propertyConfig(),
  );
});

test("encode → decode round-trips every window and identity", () => {
  fc.assert(
    fc.property(
      fc.double({ noDefaultInfinity: true, noNaN: true }).filter(
        // -0 is excluded because String(-0) === "0" loses the sign.
        (score) => !Object.is(score, -0),
      ),
      fc.nat({ max: 1_000_000 }),
      fc.constantFrom(
        DICTIONARY_A,
        DICTIONARY_B,
        NO_EXPANSION_DICTIONARY_IDENTITY,
      ),
      // The corpus addresses documents by uuid, which is what makes the id one
      // segment; the property holds over any id spelled without a separator.
      fc
        .string({ maxLength: 64, minLength: 1 })
        .filter((id) => !id.includes(":")),
      (score, windowStart, dictionary, id) => {
        expect(
          decodeCorpusSearchCursor(
            encodeCorpusSearchCursor({ dictionary, id, score, windowStart }),
          ),
        ).toEqual({ dictionary, id, score, windowStart });
      },
    ),
    propertyConfig(),
  );
});

import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  CORPUS_READ_TARGET_IDENTITY_LENGTH,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
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
const TARGET_A = "c".repeat(CORPUS_READ_TARGET_IDENTITY_LENGTH);
const TARGET_B = "d".repeat(CORPUS_READ_TARGET_IDENTITY_LENGTH);

test("a cursor over groups under their manifests' contracts keeps its form", () => {
  // Byte-identical to the form issued before read targets existed.
  expect(
    encodeCorpusSearchCursor({
      dictionary: DICTIONARY_A,
      id: DECISION_ID,
      score: 0.5,
      sort: "newest",
      target: null,
      windowStart: 900,
    }),
  ).toBe(encodeCursor(0.5, `900:${HASH_A}:newest:${DECISION_ID}`));
  expect(
    encodeCorpusSearchCursor({
      dictionary: DICTIONARY_A,
      id: DECISION_ID,
      score: 0.5,
      sort: "newest",
      target: TARGET_A,
      windowStart: 900,
    }),
  ).toBe(encodeCursor(0.5, `900:${HASH_A}:newest:${TARGET_A}:${DECISION_ID}`));
});

test("a cursor continues only against the read target it was cut from", () => {
  const ranking = { dictionary: DICTIONARY_A, sort: "relevance" } as const;
  const cut = (target: string | null) =>
    decodeCorpusSearchCursor(
      encodeCorpusSearchCursor({
        ...ranking,
        id: DECISION_ID,
        score: 0.5,
        target,
        windowStart: 0,
      }),
    );
  expect(
    isStaleCorpusSearchCursor(cut(TARGET_A), { ...ranking, target: TARGET_A }),
  ).toBe(false);
  // Another contract or target set: a replaced generation, or a group that
  // joined or left a global read.
  expect(
    isStaleCorpusSearchCursor(cut(TARGET_A), { ...ranking, target: TARGET_B }),
  ).toBe(true);
  // A legacy cursor, or one cut from a base-only read, never continues a read
  // whose target has a contract of its own, nor the other way round.
  expect(
    isStaleCorpusSearchCursor(cut(null), { ...ranking, target: TARGET_A }),
  ).toBe(true);
  expect(
    isStaleCorpusSearchCursor(
      decodeCorpusSearchCursor(encodeCursor(0.5, `900:${DECISION_ID}`)),
      {
        dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
        sort: "relevance",
        target: TARGET_A,
      },
    ),
  ).toBe(true);
  expect(
    isStaleCorpusSearchCursor(cut(TARGET_A), { ...ranking, target: null }),
  ).toBe(true);
  // A target segment of any other shape is not one this service issued.
  expect(
    decodeCorpusSearchCursor(
      encodeCursor(0.5, `0:none:relevance:${"c".repeat(31)}:${DECISION_ID}`),
    ),
  ).toBeNull();
});

test("a cursor round-trips the window, dictionary and order of its page", () => {
  const cursor = {
    dictionary: DICTIONARY_A,
    id: DECISION_ID,
    score: 0.875,
    sort: "newest",
    windowStart: 900,
    target: null,
  } as const;

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
    sort: "relevance",
    windowStart: 0,
    target: null,
  });

  expect(decodeCorpusSearchCursor(cursor)?.dictionary).toEqual(
    NO_EXPANSION_DICTIONARY_IDENTITY,
  );
  expect(
    isStaleCorpusSearchCursor(decodeCorpusSearchCursor(cursor), {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      sort: "relevance",
      target: null,
    }),
  ).toBe(false);
});

// The order a page was cut from is part of what its boundary means: a
// position in a relevance ranking bounds nothing in a date ranking, so
// continuing one into the other would skip and repeat decisions.
test("a cursor continues only in the order it was cut from", () => {
  const newest = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor({
      dictionary: DICTIONARY_A,
      id: DECISION_ID,
      score: 0.4,
      sort: "newest",
      windowStart: 12,
      target: null,
    }),
  );

  expect(newest?.sort).toBe("newest");
  expect(
    isStaleCorpusSearchCursor(newest, {
      dictionary: DICTIONARY_A,
      sort: "newest",
      target: null,
    }),
  ).toBe(false);
  expect(
    isStaleCorpusSearchCursor(newest, {
      dictionary: DICTIONARY_A,
      sort: "relevance",
      target: null,
    }),
  ).toBe(true);
});

test("a cursor continues only against the dictionary it names", () => {
  const cursor = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor({
      dictionary: DICTIONARY_A,
      id: DECISION_ID,
      score: 0.4,
      sort: "relevance",
      windowStart: 12,
      target: null,
    }),
  );

  expect(
    isStaleCorpusSearchCursor(cursor, {
      dictionary: DICTIONARY_A,
      sort: "relevance",
      target: null,
    }),
  ).toBe(false);
  expect(
    isStaleCorpusSearchCursor(cursor, {
      dictionary: DICTIONARY_B,
      sort: "relevance",
      target: null,
    }),
  ).toBe(true);
  // A rebuilt or unreachable dictionary is not the one that ranked page 1.
  expect(
    isStaleCorpusSearchCursor(cursor, {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      sort: "relevance",
      target: null,
    }),
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
      sort: "relevance",
      windowStart: 0,
      target: null,
    }),
  );

  expect(
    isStaleCorpusSearchCursor(cursor, {
      dictionary: DICTIONARY_A,
      sort: "relevance",
      target: null,
    }),
  ).toBe(true);
});

test("a first page is never stale", () => {
  expect(
    isStaleCorpusSearchCursor(null, {
      dictionary: DICTIONARY_A,
      sort: "relevance",
      target: null,
    }),
  ).toBe(false);
  expect(
    isStaleCorpusSearchCursor(null, {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      sort: "newest",
      target: null,
    }),
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
    sort: "relevance",
    windowStart: 0,
    target: null,
  });
});

test("reads a cursor from before the dictionary field in its own window", () => {
  expect(
    decodeCorpusSearchCursor(encodeCursor(0.5, `900:${DECISION_ID}`)),
  ).toEqual({
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    id: DECISION_ID,
    score: 0.5,
    sort: "relevance",
    windowStart: 900,
    target: null,
  });
});

// The form that predates sorting only: its window and dictionary are read as
// written, and relevance is the order every replica issuing it could produce.
test("reads a cursor from before the order field as a relevance page", () => {
  expect(
    decodeCorpusSearchCursor(encodeCursor(0.5, `900:${HASH_A}:${DECISION_ID}`)),
  ).toEqual({
    dictionary: DICTIONARY_A,
    id: DECISION_ID,
    score: 0.5,
    sort: "relevance",
    windowStart: 900,
    target: null,
  });
});

// The legacy readers admit a missing field, never a wrong one.
test("a legacy cursor is not a way past the identity check", () => {
  expect(
    isStaleCorpusSearchCursor(
      decodeCorpusSearchCursor(encodeCursor(0.25, `900:${DECISION_ID}`)),
      { dictionary: DICTIONARY_A, sort: "relevance", target: null },
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
  // An order this service does not declare is not one it ranked a page in.
  `900:none:oldest:${DECISION_ID}`,
  `900:none:relevance:extra:${DECISION_ID}`,
  // Nothing left to page from.
  "900:",
  `900:${HASH_A}:`,
  `900:none:relevance:`,
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

test("encode → decode round-trips every window, identity and order", () => {
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
      fc.constantFrom(...SEARCH_SORTS),
      fc.constantFrom(null, TARGET_A, TARGET_B),
      (score, windowStart, dictionary, id, sort, target) => {
        expect(
          decodeCorpusSearchCursor(
            encodeCorpusSearchCursor({
              dictionary,
              id,
              score,
              sort,
              windowStart,
              target,
            }),
          ),
        ).toEqual({ dictionary, id, score, sort, windowStart, target });
      },
    ),
    propertyConfig(),
  );
});

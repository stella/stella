import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import { CORPUS_INDEX_RANKING_MODES } from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  CORPUS_CURSOR_GROUP_TOKEN_CHARS,
  CORPUS_READ_TARGET_IDENTITY_LENGTH,
  CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
  type CorpusSearchPhase,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
import {
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  isCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";
import {
  type ExpansionDictionaryIdentity,
  NO_EXPANSION_DICTIONARY_IDENTITY,
} from "@/api/lib/legal-search/morphology/dictionary";
import { LIMITS } from "@/api/lib/limits";
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

test("a continuation carries the groups earlier windows showed, with or without a target", () => {
  const groups = ["AbC_1-", "zz9900"];
  for (const target of [null, TARGET_A]) {
    const cursor = {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      excludedGroups: groups,
      id: DECISION_ID,
      score: 1.25,
      sort: "relevance" as const,
      target,
      windowStart: 900,
    };

    const encoded = encodeCorpusSearchCursor(cursor);

    expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
    expect(encoded.length).toBeLessThanOrEqual(
      CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
    );
  }
});

test("a cursor without groups keeps the form it had", () => {
  const cursor = {
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    id: DECISION_ID,
    score: 0.5,
    sort: "relevance" as const,
    target: null,
    windowStart: 0,
  };

  expect(encodeCorpusSearchCursor({ ...cursor, excludedGroups: [] })).toBe(
    encodeCorpusSearchCursor(cursor),
  );
  expect(decodeCorpusSearchCursor(encodeCorpusSearchCursor(cursor))).toEqual(
    cursor,
  );
});

test("the longest groups segment still fits the declared cap", () => {
  const cursor = {
    dictionary: DICTIONARY_A,
    excludedGroups: Array.from(
      { length: LIMITS.corpusIndexSearchMaxExcludedGroups },
      (_, index) =>
        String(index).padStart(CORPUS_CURSOR_GROUP_TOKEN_CHARS, "0"),
    ),
    id: DECISION_ID,
    score: -0.0000012345678901234567,
    sort: "relevance" as const,
    target: TARGET_A,
    windowStart: 9_999_999_999,
  };

  expect(encodeCorpusSearchCursor(cursor).length).toBeLessThanOrEqual(
    CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  );
});

test.each([
  ["a groups segment of a partial token", "xabc"],
  ["an empty groups segment", "x"],
  ["a token outside the alphabet", "xab.def"],
  [
    "more groups than the bound",
    `x${"a".repeat(CORPUS_CURSOR_GROUP_TOKEN_CHARS * (LIMITS.corpusIndexSearchMaxExcludedGroups + 1))}`,
  ],
])("refuses %s", (_label, segment) => {
  expect(
    decodeCorpusSearchCursor(
      encodeCursor(0.5, `900:none:relevance:${segment}:${DECISION_ID}`),
    ),
  ).toBeNull();
});

test("ranking modes survive cursor encoding with targets and excluded groups", () => {
  assertProperty(
    "ranking modes survive cursor encoding with targets and excluded groups",
    fc.property(
      fc.constantFrom("off", "bm25-ratio"),
      fc.constantFrom(null, TARGET_A),
      fc.constantFrom([], ["AbC_1-"]),
      (rankingMode, target, excludedGroups) => {
        const cursor = {
          dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
          id: DECISION_ID,
          score: 1,
          sort: "relevance" as const,
          windowStart: 0,
          rankingMode,
          target,
          ...(excludedGroups.length === 0 ? {} : { excludedGroups }),
        };
        const encoded = encodeCorpusSearchCursor(cursor);
        expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
        expect(encoded.length).toBeLessThanOrEqual(
          CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
        );
      },
    ),
  );
});

const phaseCursor = (phase: CorpusSearchPhase) => ({
  dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
  id: DECISION_ID,
  score: 0.5,
  sort: "relevance" as const,
  target: null,
  windowStart: 0,
  phase,
});

const phaseSegment = (phase: unknown): string =>
  `p${Buffer.from(JSON.stringify(phase)).toString("base64url")}`;

const STRICT_PHASE = {
  type: "strict",
  fingerprint: HASH_A,
  generation: "legislation_v2",
} as const satisfies CorpusSearchPhase;

test("legislation phases round-trip independently of existing optional cursor segments", () => {
  assertProperty(
    "legislation phases round-trip independently of existing optional cursor segments",
    fc.property(
      fc.boolean(),
      fc.uniqueArray(fc.nat({ max: 999_999 }), {
        maxLength: LIMITS.corpusIndexSearchMaxExcludedGroups,
      }),
      fc.constantFrom(null, TARGET_A),
      fc.boolean(),
      fc.constantFrom(undefined, ...CORPUS_INDEX_RANKING_MODES),
      (relaxed, tokenNumbers, target, carryGroups, rankingMode) => {
        const strictWorkTokens = tokenNumbers.map((value) =>
          String(value).padStart(CORPUS_CURSOR_GROUP_TOKEN_CHARS, "0"),
        );
        const phase = relaxed
          ? ({
              type: "relaxed",
              fingerprint: HASH_A,
              generation: "legislation_v2",
              strictWorkTokens,
            } as const)
          : STRICT_PHASE;
        const cursor = {
          ...phaseCursor(phase),
          target,
          ...(carryGroups ? { excludedGroups: ["AbC_1-"] } : {}),
          ...(rankingMode === undefined ? {} : { rankingMode }),
        };
        const encoded = encodeCorpusSearchCursor(cursor);
        expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
        expect(encoded.length).toBeLessThanOrEqual(
          CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
        );
      },
    ),
  );
});

test("a cursor carrying a phase and a ranking mode round-trips both", () => {
  const relaxed = {
    type: "relaxed",
    fingerprint: HASH_A,
    generation: "legislation_v2",
    strictWorkTokens: ["AbC_1-"],
  } as const satisfies CorpusSearchPhase;
  for (const rankingMode of CORPUS_INDEX_RANKING_MODES) {
    for (const phase of [STRICT_PHASE, relaxed]) {
      const cursor = {
        ...phaseCursor(phase),
        excludedGroups: ["zz9900"],
        rankingMode,
        target: TARGET_A,
      };
      const encoded = encodeCorpusSearchCursor(cursor);
      expect(encoded).toBe(
        encodeCursor(
          0.5,
          `0:none:relevance:${TARGET_A}:xzz9900:${phaseSegment(phase)}:r-${rankingMode}:${DECISION_ID}`,
        ),
      );
      expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
    }
  }
});

test("optional segments are refused when repeated, reordered or unknown", () => {
  const phase = phaseSegment(STRICT_PHASE);
  for (const optional of [
    `r-off:${phase}`,
    "r-off:xAbC_1-",
    `r-off:${TARGET_A}`,
    "xAbC_1-:xAbC_1-",
    "r-off:r-off",
    "r-off:r-bm25-ratio",
    "r-other",
    "r-",
    `${phase}:r-off:${phase}`,
    `xAbC_1-:${TARGET_A}:r-off`,
    `${TARGET_A}:${TARGET_A}`,
  ]) {
    expect(
      decodeCorpusSearchCursor(
        encodeCursor(0.5, `0:none:relevance:${optional}:${DECISION_ID}`),
      ),
    ).toBeNull();
  }
});

test("the longest cursor the encoder can emit fits the legislation cursor cap", () => {
  const tokens = Array.from(
    { length: LIMITS.corpusIndexSearchMaxExcludedGroups },
    (_, index) => String(index).padStart(CORPUS_CURSOR_GROUP_TOKEN_CHARS, "0"),
  );
  const longest = <T extends string>(values: readonly T[]): T =>
    values.toSorted((a, b) => b.length - a.length).at(0) ??
    panic("no values to choose from");
  const cursor = {
    dictionary: DICTIONARY_A,
    excludedGroups: tokens,
    id: DECISION_ID,
    phase: {
      type: "relaxed",
      fingerprint: HASH_A,
      generation: "a".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH),
      strictWorkTokens: tokens,
    },
    rankingMode: longest(CORPUS_INDEX_RANKING_MODES),
    score: -0.0000012345678901234567,
    sort: longest(SEARCH_SORTS),
    target: TARGET_A,
    windowStart: 9_999_999_999,
  } as const;
  const encoded = encodeCorpusSearchCursor(cursor);
  expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
  expect(encoded.length).toBeLessThanOrEqual(
    CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
  );
  // The cap is derived from the parts, so the worst case sits just under it:
  // a loose cap would hide a segment the derivation forgot.
  expect(encoded.length).toBeGreaterThan(
    CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH - 8,
  );
});

test("a phase cursor requires the same query, generation and continuation phase", () => {
  const cursor = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor(phaseCursor(STRICT_PHASE)),
  );
  const ranking = {
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    sort: "relevance",
    target: null,
  } as const;
  expect(
    isStaleCorpusSearchCursor(cursor, { ...ranking, phase: STRICT_PHASE }),
  ).toBe(false);
  expect(isStaleCorpusSearchCursor(cursor, ranking)).toBe(true);
  expect(
    isStaleCorpusSearchCursor(cursor, {
      ...ranking,
      phase: { ...STRICT_PHASE, fingerprint: HASH_B },
    }),
  ).toBe(true);
  expect(
    isStaleCorpusSearchCursor(cursor, {
      ...ranking,
      phase: { ...STRICT_PHASE, generation: "legislation_v3" },
    }),
  ).toBe(true);
  expect(
    isStaleCorpusSearchCursor(cursor, {
      ...ranking,
      phase: {
        type: "relaxed",
        fingerprint: HASH_A,
        generation: "legislation_v2",
        strictWorkTokens: [],
      },
    }),
  ).toBe(true);
  const unphased = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor({
      ...ranking,
      id: DECISION_ID,
      score: 0.5,
      windowStart: 0,
    }),
  );
  expect(
    isStaleCorpusSearchCursor(unphased, { ...ranking, phase: STRICT_PHASE }),
  ).toBe(true);
  expect(
    isStaleCorpusSearchCursor(null, { ...ranking, phase: STRICT_PHASE }),
  ).toBe(false);
});

test("relaxed continuation exclusions are payload, rather than a second phase identity", () => {
  const phase = {
    type: "relaxed",
    fingerprint: HASH_A,
    generation: "legislation_v2",
    strictWorkTokens: ["AbC_1-"],
  } as const;
  const cursor = decodeCorpusSearchCursor(
    encodeCorpusSearchCursor(phaseCursor(phase)),
  );
  expect(
    isStaleCorpusSearchCursor(cursor, {
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      sort: "relevance",
      target: null,
      phase: {
        type: "relaxed",
        fingerprint: HASH_A,
        generation: "legislation_v2",
        strictWorkTokens: [],
      },
    }),
  ).toBe(false);
});

test.each(
  [
    null,
    [],
    { ...STRICT_PHASE, type: "other" },
    { ...STRICT_PHASE, fingerprint: HASH_A.slice(1) },
    { ...STRICT_PHASE, fingerprint: HASH_A.toUpperCase() },
    { ...STRICT_PHASE, generation: "" },
    { ...STRICT_PHASE, generation: "../legislation_v2" },
    { ...STRICT_PHASE, generation: "a".repeat(65) },
    { ...STRICT_PHASE, extra: "unexpected" },
    { ...STRICT_PHASE, strictWorkTokens: [] },
    { ...STRICT_PHASE, type: "relaxed" },
    { ...STRICT_PHASE, type: "relaxed", strictWorkTokens: "AbC_1-" },
    { ...STRICT_PHASE, type: "relaxed", strictWorkTokens: ["short"] },
    { ...STRICT_PHASE, type: "relaxed", strictWorkTokens: ["ab.def"] },
    { ...STRICT_PHASE, type: "relaxed", strictWorkTokens: [1] },
    {
      ...STRICT_PHASE,
      type: "relaxed",
      strictWorkTokens: ["AbC_1-", "AbC_1-"],
    },
    {
      ...STRICT_PHASE,
      type: "relaxed",
      strictWorkTokens: Array.from(
        { length: LIMITS.corpusIndexSearchMaxExcludedGroups + 1 },
        (_, index) => String(index).padStart(6, "0"),
      ),
    },
  ].map((phase) => ({ phase })),
)("rejects malformed phase data %p", ({ phase }) => {
  expect(
    decodeCorpusSearchCursor(
      encodeCursor(
        0.5,
        `0:none:relevance:${phaseSegment(phase)}:${DECISION_ID}`,
      ),
    ),
  ).toBeNull();
});

test("phase segments are canonical base64url and occur once after other optional metadata", () => {
  const segment = phaseSegment(STRICT_PHASE);
  for (const optional of [
    "p",
    "p!",
    "pbm90LWpzb24",
    `${segment}=`,
    `${segment}:${segment}`,
    `${segment}:xAbC_1-`,
    `${segment}:${TARGET_A}`,
  ]) {
    expect(
      decodeCorpusSearchCursor(
        encodeCursor(0.5, `0:none:relevance:${optional}:${DECISION_ID}`),
      ),
    ).toBeNull();
  }
});

test.each(['{"type":"strict', "{", '"unterminated'])(
  "malformed phase JSON %s rejects the cursor",
  (json) => {
    const segment = `p${Buffer.from(json).toString("base64url")}`;
    expect(
      decodeCorpusSearchCursor(
        encodeCursor(0.5, `0:none:relevance:${segment}:${DECISION_ID}`),
      ),
    ).toBeNull();
  },
);

test("the maximum phase and group payload fits the legislation-only cursor cap", () => {
  const tokens = Array.from(
    { length: LIMITS.corpusIndexSearchMaxExcludedGroups },
    (_, index) => String(index).padStart(CORPUS_CURSOR_GROUP_TOKEN_CHARS, "0"),
  );
  const cursor = {
    ...phaseCursor({
      type: "relaxed",
      fingerprint: HASH_A,
      generation: "A.b-".repeat(8),
      strictWorkTokens: tokens,
    }),
    dictionary: DICTIONARY_A,
    excludedGroups: tokens,
    target: TARGET_A,
    score: -0.0000012345678901234567,
    windowStart: 9_999_999_999,
  };
  const encoded = encodeCorpusSearchCursor(cursor);
  expect(encoded.length).toBeGreaterThan(
    CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  );
  expect(encoded.length).toBeLessThanOrEqual(
    CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
  );
  expect(decodeCorpusSearchCursor(encoded)).toEqual(cursor);
});

test("phase generations use the corpus generation grammar", () => {
  assertProperty(
    "phase generations use the corpus generation grammar",
    fc.property(fc.string({ maxLength: 40 }), (generation) => {
      const phase = { type: "strict", fingerprint: HASH_A, generation };
      const decoded = decodeCorpusSearchCursor(
        encodeCursor(
          0.5,
          `0:none:relevance:${phaseSegment(phase)}:${DECISION_ID}`,
        ),
      );
      expect(decoded !== null).toBe(isCorpusIndexGeneration(generation));
    }),
  );
  for (const generation of ["A", "Legal.V2", "A.b-".repeat(8)]) {
    const cursor = phaseCursor({ ...STRICT_PHASE, generation });
    expect(decodeCorpusSearchCursor(encodeCorpusSearchCursor(cursor))).toEqual(
      cursor,
    );
  }
});

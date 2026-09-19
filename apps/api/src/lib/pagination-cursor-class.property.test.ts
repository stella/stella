/**
 * The predicate that reads a made-up cursor as absence is only sound while
 * every encoder on the agent surface stays inside the class it describes. One
 * encoder drifting out of it means a real page boundary silently restarts its
 * caller at page one, which no `Invalid cursor` would announce.
 *
 * So the encoders are exercised here rather than the predicate restated: each
 * one is given the values it actually emits for, and its output has to be
 * recognizable. `encodeGlobalSearchCursor` is the reason the predicate carries
 * no length rule: it concatenates two base64 payloads around `==`, so no
 * single base64 length class covers it.
 *
 * `search_boe_legislation` is deliberately absent: the BOE numbers its own
 * pages, so a decimal offset is what a continuation echoes. That property
 * declares its own `issuedBy`, and `cursor-inputs.test.ts` holds it.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { encodeDecisionSearchCursor } from "@/api/lib/case-law/decision-search-cursor";
import { encodeEntitiesWindowCursor } from "@/api/lib/entities/window-cursor";
import { encodeCorpusSearchCursor } from "@/api/lib/legal-search/corpus-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import {
  encodePaginationCursor,
  isIssuablePaginationCursor,
} from "@/api/lib/pagination";
import { encodeCursor } from "@/api/lib/search/cursor";
import { encodeGlobalSearchCursor } from "@/api/lib/search/pagination";

const uuidArbitrary = fc.uuid();

/** A hit id as the global search mints it: one of its declared prefixes. */
const globalHitIdArbitrary = fc
  .constantFrom("entity", "matter", "contact", "case-law", "chat")
  .chain((prefix) => uuidArbitrary.map((id) => `${prefix}:${id}`));

const scoreArbitrary = fc.double({
  min: 0,
  max: 1,
  noDefaultInfinity: true,
  noNaN: true,
});

/** A sort value a corpus row can carry: arbitrary tenant text, or a number. */
const sortValueArbitrary = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.integer(),
  fc.constant(null),
);

const timestampArbitrary = fc
  .date({ min: new Date("1970-01-01T00:00:00Z"), noInvalidDate: true })
  .map((value) => value.toISOString());

describe("every cursor encoder emits a cursor the surface recognizes", () => {
  test("encodePaginationCursor, over the part kinds it accepts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            sortValueArbitrary,
            fc.boolean(),
            fc.dictionary(fc.string({ maxLength: 40 }), sortValueArbitrary, {
              maxKeys: 4,
            }),
          ),
          { maxLength: 6 },
        ),
        (parts) =>
          expect(
            isIssuablePaginationCursor(encodePaginationCursor(parts)),
          ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("encodeEntitiesWindowCursor, over the sort values a row carries", () => {
    fc.assert(
      fc.property(fc.array(sortValueArbitrary, { maxLength: 8 }), (values) =>
        expect(
          isIssuablePaginationCursor(encodeEntitiesWindowCursor(values)),
        ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("encodeCursor, the shared (score, id) framing", () => {
    fc.assert(
      fc.property(scoreArbitrary, uuidArbitrary, (score, id) =>
        expect(isIssuablePaginationCursor(encodeCursor(score, id))).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("encodeGlobalSearchCursor, whose dual form carries an inner ==", () => {
    fc.assert(
      fc.property(
        scoreArbitrary,
        globalHitIdArbitrary,
        fc.integer({ min: 1, max: 999 }),
        (score, id, seen) =>
          expect(
            isIssuablePaginationCursor(
              encodeGlobalSearchCursor({ score, id, seen }),
            ),
          ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("encodeCorpusSearchCursor, over its window and order segments", () => {
    fc.assert(
      fc.property(
        scoreArbitrary,
        uuidArbitrary,
        fc.integer({ min: 0, max: 9_999_999 }),
        fc.constantFrom(...SEARCH_SORTS),
        (score, id, windowStart, sort) =>
          expect(
            isIssuablePaginationCursor(
              encodeCorpusSearchCursor({
                dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
                id,
                score,
                sort,
                windowStart,
              }),
            ),
          ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("encodeDecisionSearchCursor, over its order segment", () => {
    fc.assert(
      fc.property(
        scoreArbitrary,
        uuidArbitrary,
        fc.constantFrom(...SEARCH_SORTS),
        (sortKey, id, sort) =>
          expect(
            isIssuablePaginationCursor(
              encodeDecisionSearchCursor({ id, sort, sortKey }),
            ),
          ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("the keyset codecs built on encodePaginationCursor", () => {
    fc.assert(
      fc.property(timestampArbitrary, uuidArbitrary, (timestamp, id) =>
        expect(
          isIssuablePaginationCursor(encodePaginationCursor([timestamp, id])),
        ).toBe(true),
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a whole cursor can be six characters, so the class has no length floor", () => {
    // `WzIwXQ` is `[20]`: the text-window cursor at offset 20.
    expect(encodePaginationCursor([20])).toBe("WzIwXQ");
    expect(isIssuablePaginationCursor("WzIwXQ")).toBe(true);
  });
});

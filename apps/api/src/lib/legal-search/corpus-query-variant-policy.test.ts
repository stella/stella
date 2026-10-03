import { expect, test } from "bun:test";
import * as v from "valibot";

import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  CORPUS_INDEX_QUERY_VARIANTS,
  corpusQueryVariant,
  corpusQueryVariantCursorTarget,
} from "@/api/lib/legal-search/corpus-query-variant-policy";
import {
  CORPUS_INDEX_RANKING_MODES,
  corpusRankingCursorTarget,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";

test("query variants default off and reject unknown configuration", () => {
  const schema = envBaseServerSchema.CORPUS_INDEX_QUERY_VARIANT;
  expect(v.parse(schema, undefined)).toBe("off");
  for (const variant of CORPUS_INDEX_QUERY_VARIANTS) {
    expect(v.parse(schema, variant)).toBe(variant);
    expect(
      corpusQueryVariant({ configuredVariant: variant, verbatim: false }),
    ).toBe(variant);
    expect(
      corpusQueryVariant({ configuredVariant: variant, verbatim: true }),
    ).toBe("off");
  }
  expect(v.safeParse(schema, "typo").success).toBe(false);
});

test("ranking and query variants distinguish every cursor target while off preserves it", () => {
  for (const target of [null, "a".repeat(32)]) {
    expect(corpusQueryVariantCursorTarget(target, "off")).toBe(target);
    const targets = CORPUS_INDEX_RANKING_MODES.flatMap((mode) =>
      CORPUS_INDEX_QUERY_VARIANTS.map((variant) => {
        const rankedTarget = corpusRankingCursorTarget(target, mode);
        const combined = corpusQueryVariantCursorTarget(rankedTarget, variant);
        expect(corpusQueryVariantCursorTarget(rankedTarget, variant)).toBe(
          combined,
        );
        return combined;
      }),
    );
    expect(new Set(targets).size).toBe(
      CORPUS_INDEX_RANKING_MODES.length * CORPUS_INDEX_QUERY_VARIANTS.length,
    );
  }
});

test("a cursor minted under either query variant is stale under the other", () => {
  const ranking = {
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    sort: "relevance",
  } as const;
  for (const variant of CORPUS_INDEX_QUERY_VARIANTS) {
    const target = corpusQueryVariantCursorTarget("a".repeat(32), variant);
    const cursor = decodeCorpusSearchCursor(
      encodeCorpusSearchCursor({
        ...ranking,
        id: "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a",
        score: 0.5,
        windowStart: 0,
        target,
      }),
    );
    expect(cursor).not.toBeNull();
    for (const nextVariant of CORPUS_INDEX_QUERY_VARIANTS) {
      expect(
        isStaleCorpusSearchCursor(cursor, {
          ...ranking,
          target: corpusQueryVariantCursorTarget("a".repeat(32), nextVariant),
        }),
      ).toBe(variant !== nextVariant);
    }
  }
});

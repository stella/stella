import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import type { Static } from "elysia";
import fc from "fast-check";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { DECISION_TYPE_KIND_OTHER } from "@stll/api-contract/case-law-decision-types";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";
import { assertProperty } from "@stll/property-testing";

import { LIMITS } from "@/api/lib/limits";
import { escapeSearchHtml } from "@/api/lib/search/highlight";
import { responseByteBound } from "@/api/lib/search/response-byte-bound";

import { projectCaseLawSearchResponse } from "./search-response";
import { searchDecisionsSuccessResponseSchema } from "./search-schema";

type SearchResponse = Static<typeof searchDecisionsSuccessResponseSchema>;
const responseWithText = (text: string): SearchResponse => {
  const bucket = { value: text, label: text, count: Number.MAX_SAFE_INTEGER };
  const hit = {
    decisionId: text,
    caseNumber: text,
    caseNumberType: "case-number",
    slug: text,
    ecli: text,
    identifiers: [{ type: "case-number", value: text }],
    court: text,
    courtAbbreviation: text,
    courtTier: COURT_TIER_LABELS[0],
    country: text,
    language: text,
    languageAlternates: Array.from(
      { length: LIMITS.caseLawLanguageAlternatesPerGroupMax + 1 },
      () => ({
        caseNumber: text,
        country: text,
        court: text,
        decisionDate: text,
        id: text,
        language: text,
        slug: text,
      }),
    ),
    decisionDate: text,
    decisionType: text,
    sourceUrl: text,
    headnote: {
      type: "keywords",
      items: Array.from(
        { length: LIMITS.caseLawHeadnoteKeywords + 1 },
        () => text,
      ),
      omitted: 0,
    },
    headline: `<mark>${escapeSearchHtml(text)}</mark>`,
    anchorId: text,
    citationCount: Number.MAX_VALUE,
    citationAuthority: -Number.MAX_VALUE,
    matchingPassages: Number.MAX_SAFE_INTEGER,
    createdAt: text,
  } as const satisfies SearchResponse["hits"][number];
  return {
    hits: Array.from({ length: 2 }, () => hit),
    facets: {
      court: COURT_TIER_LABELS.map((tierLabel) => ({
        tierLabel,
        courts: Array.from(
          { length: LIMITS.caseLawFacetLimit + 1 },
          () => bucket,
        ),
      })),
      year: Array.from(
        { length: LIMITS.caseLawYearFacetLimit + 1 },
        () => bucket,
      ),
      decisionType: [{ ...bucket, value: DECISION_TYPE_KIND_OTHER }],
      source: [{ ...bucket, countType: "exact" }],
      language: [bucket],
    },
    total: SEARCH_TOTAL_NOT_COUNTED,
    nextCursor: text,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    queryUsed: text,
    warnings: [{ code: "function_words_optional", message: text, hint: text }],
  };
};

test("case-law search envelopes bound Unicode and every nested collection", () => {
  assertProperty(
    "case-law search envelopes bound Unicode and every nested collection",
    fc.property(
      fc.array(
        fc.constantFrom(
          "😀",
          "ř",
          "e\u0301",
          "\u0000",
          '"',
          "\\",
          "\ud800",
          "&",
        ),
        { minLength: 1, maxLength: 4 },
      ),
      (parts) => {
        const text = parts.join("").repeat(20_000);
        const response = projectCaseLawSearchResponse(responseWithText(text));
        expect(
          Value.Check(searchDecisionsSuccessResponseSchema, response),
        ).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
          responseByteBound(searchDecisionsSuccessResponseSchema),
        );
        for (const hit of response.hits) {
          expect(hit.headline?.match(/<mark>/gu)?.length ?? 0).toBe(
            hit.headline?.match(/<\/mark>/gu)?.length ?? 0,
          );
        }
      },
    ),
    { numRuns: 12 },
  );
});

test("case-law search caps a complete page envelope before serialization", () => {
  const fixture = responseWithText("ř");
  const hit = fixture.hits.at(0);
  expect(hit).toBeDefined();
  if (hit === undefined) {
    return;
  }
  const response = projectCaseLawSearchResponse({
    ...fixture,
    hits: Array.from(
      { length: LIMITS.caseLawSearchPageSizeMax + 1 },
      () =>
        ({
          ...hit,
          headnote: {
            type: "present",
            text: "😀".repeat(1000),
            truncated: false,
          },
        }) as const satisfies SearchResponse["hits"][number],
    ),
  });
  expect(response.hits).toHaveLength(LIMITS.caseLawSearchPageSizeMax);
  expect(response.hits.at(0)?.headnote).toEqual({
    type: "present",
    text: "😀".repeat(LIMITS.caseLawHeadnoteMaxChars),
    truncated: true,
  });
  expect(Value.Check(searchDecisionsSuccessResponseSchema, response)).toBe(
    true,
  );
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
    responseByteBound(searchDecisionsSuccessResponseSchema),
  );
});

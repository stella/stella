import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import type { Static } from "elysia";
import fc from "fast-check";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { DECISION_TYPE_KIND_OTHER } from "@stll/api-contract/case-law-decision-types";
import {
  SEARCH_PAGE_REACH,
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
    keywords: null,
    headnote: {
      type: "keywords",
      items: Array.from(
        { length: LIMITS.caseLawHeadnoteKeywords + 1 },
        () => text,
      ),
      omitted: 0,
    },
    textWithheldReason: null,
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
      courtYear: null,
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
    pageReach: SEARCH_PAGE_REACH.REACHED,
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

test.each([false, true])(
  "case-law search preserves populated court/year facets with truncated=%s",
  (truncated) => {
    const courtYear = {
      buckets: [
        {
          court: "Nejvyšší soud",
          courtName: "Nejvyšší soud",
          courtAbbreviation: "NS",
          tier: "supreme",
          year: 2024,
          count: 17,
          citationSum: null,
          treatment: null,
        },
        {
          court: "Krajský soud v Brně",
          courtName: "Krajský soud v Brně",
          courtAbbreviation: null,
          tier: "regional",
          year: 2025,
          count: 3,
          citationSum: null,
          treatment: null,
        },
      ],
      truncated,
    } as const satisfies NonNullable<
      NonNullable<SearchResponse["facets"]>["courtYear"]
    >;
    const response = projectCaseLawSearchResponse({
      ...responseWithText("ř"),
      facets: {
        court: [],
        year: [],
        decisionType: [],
        source: [],
        language: [],
        courtYear,
      },
    });
    expect(response.facets?.courtYear).toEqual(courtYear);
    expect(Value.Check(searchDecisionsSuccessResponseSchema, response)).toBe(
      true,
    );
  },
);

test("expanded search preserves the full headnote reading and separate classifications", () => {
  const fixture = responseWithText("ř");
  const hit = fixture.hits.at(0);
  if (hit === undefined) {
    throw new Error("Missing search hit");
  }
  const text = "The court requires proof of causation. ".repeat(80).trim();
  expect(text.length).toBeGreaterThan(LIMITS.caseLawHeadnoteMaxChars * 4);
  expect(text.length).toBeLessThan(LIMITS.mcpCaseLawHeadnoteMaxChars);
  const response = projectCaseLawSearchResponse(
    {
      ...fixture,
      hits: [
        {
          ...hit,
          headnote: { type: "present", text, truncated: false },
          keywords: {
            type: "keywords",
            items: ["Compensation", "Causation"],
            omitted: 0,
          },
        },
      ],
    },
    LIMITS.mcpCaseLawHeadnoteMaxChars,
  );
  expect(response.hits.at(0)?.headnote).toEqual({
    type: "present",
    text,
    truncated: false,
  });
  expect(response.hits.at(0)?.keywords).toEqual({
    type: "keywords",
    items: ["Compensation", "Causation"],
    omitted: 0,
  });
});

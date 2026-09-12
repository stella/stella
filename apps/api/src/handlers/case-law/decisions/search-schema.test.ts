import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { Static } from "elysia";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { SEARCH_TOTAL_NOT_COUNTED } from "@stll/api-contract/search";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import type {
  searchSortSchema} from "@/api/handlers/case-law/decisions/search-schema";
import {
  searchDecisionsBodySchema,
  searchDecisionsSuccessResponseSchema
} from "@/api/handlers/case-law/decisions/search-schema";
import { COURT_TIER_LABELS } from "@/api/lib/case-law/court-weights";
import {
  SEARCH_SORTS,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";

type SearchDecisionsSuccess = Extract<
  Awaited<ReturnType<typeof searchDecisionsHandler>>,
  { hits: readonly unknown[] }
>;

type HandlerResponseFitsSchema =
  SearchDecisionsSuccess extends Static<
    typeof searchDecisionsSuccessResponseSchema
  >
    ? true
    : false;

const validResponse = {
  hits: [
    {
      decisionId: "decision-id",
      caseNumber: "case-reference",
      slug: null,
      ecli: null,
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value: "case-reference",
        },
      ],
      court: "court",
      country: "XX",
      language: "xx",
      languageAlternates: [],
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      headnote: {
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
      },
      headline: null,
      anchorId: null,
      citationCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  facets: null,
  total: SEARCH_TOTAL_NOT_COUNTED,
  nextCursor: null,
};

const bucket = (value: string) => ({ value, label: null, count: 3 });

const firstPageFacets = {
  court: [{ tierLabel: "supreme", courts: [bucket("Nejvyšší soud")] }],
  year: [bucket("2024")],
  decisionType: [bucket("rozsudek")],
  source: [{ value: "source-id", label: "Nejvyšší soud ČR", count: 3 }],
  language: [bucket("cs")],
};

const validBody = { query: "promlčení", country: "CZE" };

describe("case-law search request schema", () => {
  test("names every declared sort, spelled out so Eden keeps the union", () => {
    expectTypeOf<Static<typeof searchSortSchema>>().toEqualTypeOf<SearchSort>();
  });

  test("accepts every declared sort and no sort at all", () => {
    expect(Value.Check(searchDecisionsBodySchema, validBody)).toBe(true);
    for (const sort of SEARCH_SORTS) {
      expect(
        Value.Check(searchDecisionsBodySchema, { ...validBody, sort }),
      ).toBe(true);
    }
  });

  // An order the handler does not implement would silently fall back to the
  // default, giving a reader a ranking they did not ask for.
  test.each(["oldest", "", "RELEVANCE", 1])(
    "rejects the undeclared sort %p",
    (sort) => {
      expect(
        Value.Check(searchDecisionsBodySchema, { ...validBody, sort }),
      ).toBe(false);
    },
  );
});

describe("case-law search response schema", () => {
  test("accepts every complete handler success payload", () => {
    expectTypeOf<HandlerResponseFitsSchema>().toEqualTypeOf<true>();
  });

  test("accepts the complete response", () => {
    expect(
      Value.Check(searchDecisionsSuccessResponseSchema, validResponse),
    ).toBe(true);
  });

  // Page one carries the facets; a cursor page carries null, because the
  // counts describe the result set and do not change as a reader pages.
  test("accepts a first page's facets and a cursor page's absence of them", () => {
    expect(
      Value.Check(searchDecisionsSuccessResponseSchema, {
        ...validResponse,
        facets: firstPageFacets,
      }),
    ).toBe(true);
    expect(
      Value.Check(searchDecisionsSuccessResponseSchema, {
        ...validResponse,
        facets: null,
        nextCursor: "cursor",
      }),
    ).toBe(true);
  });

  test("accepts every declared court tier", () => {
    for (const tierLabel of COURT_TIER_LABELS) {
      expect(
        Value.Check(searchDecisionsSuccessResponseSchema, {
          ...validResponse,
          facets: {
            ...firstPageFacets,
            court: [{ tierLabel, courts: [bucket("court")] }],
          },
        }),
      ).toBe(true);
    }
  });

  test.each([
    { ...validResponse, total: null },
    { ...validResponse, unexpected: true },
    // A tier the response does not declare is a heading nothing renders.
    {
      ...validResponse,
      facets: {
        ...firstPageFacets,
        court: [{ tierLabel: "appeal", courts: [] }],
      },
    },
    // A count the engine could not produce is not a zero.
    {
      ...validResponse,
      facets: {
        ...firstPageFacets,
        language: [{ value: "cs", label: null, count: null }],
      },
    },
    // A passage count is fractional only in a sketch; a decision count is not.
    {
      ...validResponse,
      facets: {
        ...firstPageFacets,
        language: [{ value: "cs", label: null, count: 3.5 }],
      },
    },
    // The facets the contract declares are the facets it declares.
    {
      ...validResponse,
      facets: { ...firstPageFacets, country: [bucket("CZE")] },
    },
  ])("rejects a response outside the declared contract", (response) => {
    expect(Value.Check(searchDecisionsSuccessResponseSchema, response)).toBe(
      false,
    );
  });
});

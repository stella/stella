import { describe, expect, expectTypeOf, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { caseLawCourtYearSchema } from "@stll/api-contract/case-law-court-year";
import { DECISION_TYPE_KINDS } from "@stll/api-contract/case-law-decision-types";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import {
  CASE_LAW_SEARCH_WARNING_CODES,
  FACET_COUNT_TYPE,
  SEARCH_EXCERPTS,
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
  type SearchExcerpt,
} from "@stll/api-contract/search";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";

import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import {
  searchDecisionsBodySchema,
  searchDecisionsSuccessResponseSchema,
} from "@/api/handlers/case-law/decisions/search-schema";
import { isHttpFailure } from "@/api/http/errors";
import { encodeResponseOutput } from "@/api/http/input";
import type { ReadonlyWire } from "@/api/lib/api-handlers";
import type { searchExcerptSchema } from "@/api/lib/case-law/search-excerpt-schema";
import type { searchSortSchema } from "@/api/lib/case-law/search-sort-schema";
import {
  SEARCH_SORTS,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";

type SearchDecisionsSuccess = Extract<
  Awaited<ReturnType<typeof searchDecisionsHandler>>,
  { hits: readonly unknown[] }
>;

// Read-only on both sides: the payload's arrays are read-only data.
type HandlerResponseFitsSchema =
  ReadonlyWire<SearchDecisionsSuccess> extends ReadonlyWire<
    v.InferInput<typeof searchDecisionsSuccessResponseSchema>
  >
    ? true
    : false;

const validResponse = {
  hits: [
    {
      decisionId: "decision-id",
      caseNumber: "case-reference",
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      slug: null,
      ecli: null,
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value: "case-reference",
        },
      ],
      court: "court",
      courtAbbreviation: null,
      courtTier: "other",
      country: "XX",
      language: "xx",
      languageAlternates: [],
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      keywords: null,
      headnote: {
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
      },
      headline: null,
      anchorId: null,
      citationCount: 0,
      citationAuthority: 0,
      textWithheldReason: null,
      textAvailability: "available",
      textState: null,
      matchingPassages: 1,
      match: "all_terms",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  facets: null,
  total: SEARCH_TOTAL_NOT_COUNTED,
  relaxedHitCount: 0,
  nextCursor: null,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  pageReach: SEARCH_PAGE_REACH.REACHED,
  queryUsed: "nájemné výpověď",
  warnings: [],
};

/** Whether the HTTP layer sends this answer, through the route's response encoder. */
const httpSends = async (response: unknown): Promise<boolean> => {
  try {
    await encodeResponseOutput(searchDecisionsSuccessResponseSchema, response);
    return true;
  } catch (error) {
    if (isHttpFailure(error)) {
      return false;
    }
    throw error;
  }
};

const bucket = (value: string) => ({ value, label: null, count: 3 });

const firstPageFacets = {
  courtYear: null,
  court: [{ tierLabel: "supreme", courts: [bucket("Nejvyšší soud")] }],
  year: [bucket("2024")],
  decisionType: [bucket("judgment")],
  source: [
    {
      value: "source-id",
      label: "Nejvyšší soud ČR",
      count: 3,
      countType: FACET_COUNT_TYPE.EXACT,
    },
  ],
  language: [bucket("cs")],
};

const validBody = { query: "promlčení", country: "CZE" };

describe("case-law search request schema", () => {
  test("source filters accept full UUIDs in either hex case and reject malformed URL ids", () => {
    const uuid = "0194d94a-1122-7000-8000-123456789abc";
    for (const sourceId of [uuid, uuid.toUpperCase()]) {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, sourceId })).toBe(
        true,
      );
    }
    for (const sourceId of [
      "source-id",
      "",
      `${uuid}\n`,
      ` ${uuid}`,
      `${uuid} `,
      uuid.replaceAll("-", ""),
      uuid.replace("a", "g"),
      42,
      null,
      [uuid],
    ]) {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, sourceId })).toBe(
        false,
      );
    }
  });

  test("names every declared sort, spelled out as a closed union", () => {
    expectTypeOf<
      v.InferOutput<typeof searchSortSchema>
    >().toEqualTypeOf<SearchSort>();
  });

  test("accepts every declared sort and no sort at all", () => {
    expect(v.is(searchDecisionsBodySchema, validBody)).toBe(true);
    for (const sort of SEARCH_SORTS) {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, sort })).toBe(
        true,
      );
    }
  });

  // An order the handler does not implement would silently fall back to the
  // default, giving a reader a ranking they did not ask for.
  test.each(["oldest", "", "RELEVANCE", 1])(
    "rejects the undeclared sort %p",
    (sort) => {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, sort })).toBe(
        false,
      );
    },
  );

  test("names every declared excerpt, spelled out as a closed union", () => {
    expectTypeOf<
      v.InferOutput<typeof searchExcerptSchema>
    >().toEqualTypeOf<SearchExcerpt>();
  });

  test("accepts every declared excerpt and no excerpt at all", () => {
    expect(v.is(searchDecisionsBodySchema, validBody)).toBe(true);
    for (const excerpt of SEARCH_EXCERPTS) {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, excerpt })).toBe(
        true,
      );
    }
  });

  // The length is a name the search maps to a window, never a size the caller
  // states: a number on the wire is a caller asking for the whole decision.
  test.each(["huge", "", "SHORT", 400, null])(
    "rejects the undeclared excerpt %p",
    (excerpt) => {
      expect(v.is(searchDecisionsBodySchema, { ...validBody, excerpt })).toBe(
        false,
      );
    },
  );
});

describe("case-law search response schema", () => {
  test("source counts carry every declared count type and reject missing or unknown types", () => {
    const responseWithCountType = (countType: unknown) => ({
      ...validResponse,
      facets: {
        ...firstPageFacets,
        source: firstPageFacets.source.map((source) => ({
          ...source,
          countType,
        })),
      },
    });
    for (const countType of Object.values(FACET_COUNT_TYPE)) {
      expect(
        v.is(
          searchDecisionsSuccessResponseSchema,
          responseWithCountType(countType),
        ),
      ).toBe(true);
    }
    for (const countType of [undefined, null, "unknown", 1]) {
      expect(
        v.is(
          searchDecisionsSuccessResponseSchema,
          responseWithCountType(countType),
        ),
      ).toBe(false);
    }
  });

  test("accepts every complete handler success payload", () => {
    expectTypeOf<HandlerResponseFitsSchema>().toEqualTypeOf<true>();
  });

  test("accepts the complete response", () => {
    expect(v.is(searchDecisionsSuccessResponseSchema, validResponse)).toBe(
      true,
    );
  });

  test("accepts every declared warning code", () => {
    for (const code of CASE_LAW_SEARCH_WARNING_CODES) {
      expect(
        v.is(searchDecisionsSuccessResponseSchema, {
          ...validResponse,
          warnings: [{ code, message: "Something", hint: "Do something" }],
        }),
      ).toBe(true);
    }
  });

  // The set is closed at the boundary, so a code the web has no wording for
  // cannot reach it: an unrenderable warning is worse than none.
  test.each(["relaxed", "", "NO_HITS", 1, null])(
    "rejects the undeclared warning code %p",
    (code) => {
      expect(
        v.is(searchDecisionsSuccessResponseSchema, {
          ...validResponse,
          warnings: [{ code, message: "Something", hint: "Do something" }],
        }),
      ).toBe(false);
    },
  );

  test("HTTP court/year validation matches the canonical aggregate schema", async () => {
    const matrixBucket = {
      court: "Nejvyšší soud",
      courtName: "Nejvyšší soud",
      courtAbbreviation: "NS",
      tier: "supreme",
      year: 2024,
      count: 3,
      citationSum: null,
      treatment: null,
    };
    for (const courtYear of [
      null,
      { buckets: [matrixBucket], truncated: false },
      { buckets: [{ ...matrixBucket, count: -1 }], truncated: false },
      { buckets: [{ ...matrixBucket, count: 1.5 }], truncated: false },
      { buckets: [{ ...matrixBucket, citationSum: -1 }], truncated: false },
      { buckets: [{ ...matrixBucket, tier: "invented" }], truncated: false },
      { buckets: [{ ...matrixBucket, extra: true }], truncated: false },
      {
        buckets: [{ ...matrixBucket, court: "x".repeat(513) }],
        truncated: false,
      },
      {
        buckets: [{ ...matrixBucket, courtName: "x".repeat(513) }],
        truncated: false,
      },
      {
        buckets: [{ ...matrixBucket, courtAbbreviation: "x".repeat(257) }],
        truncated: false,
      },
      {
        buckets: Array.from({ length: 401 }, () => matrixBucket),
        truncated: true,
      },
    ]) {
      const response = {
        ...validResponse,
        facets: { ...firstPageFacets, courtYear },
      };
      const valid = v.safeParse(caseLawCourtYearSchema, courtYear).success;
      expect(v.is(searchDecisionsSuccessResponseSchema, response)).toBe(valid);
      expect(await httpSends(response)).toBe(valid);
    }
  });

  // An undeclared field, top-level or among the facets, never reaches the
  // wire: the encoder sends the schema's output, which drops it.
  test("the response encoder sends exactly the declared fields", async () => {
    const mirrored = await encodeResponseOutput(
      searchDecisionsSuccessResponseSchema,
      {
        ...validResponse,
        unexpected: true,
        facets: { ...firstPageFacets, country: [bucket("CZE")] },
      },
    );
    expect(v.is(searchDecisionsSuccessResponseSchema, mirrored)).toBe(true);
    expect(mirrored.facets?.courtYear).toBeNull();
    expect(Object.hasOwn(mirrored, "unexpected")).toBe(false);
    expect(
      mirrored.facets !== null && Object.hasOwn(mirrored.facets, "country"),
    ).toBe(false);
  });

  test("HTTP court/year validation agrees with the canonical contract for generated values", async () => {
    const count = fc.oneof(
      fc.integer({ min: 0, max: 10_000 }),
      fc.constant(-1),
      fc.constant(1.5),
      fc.constant(Number.MAX_SAFE_INTEGER + 1),
    );
    const matrix = fc.record({
      buckets: fc.array(
        fc.record({
          court: fc.string({ maxLength: 530 }),
          courtName: fc.string({ maxLength: 530 }),
          courtAbbreviation: fc.option(fc.string({ maxLength: 270 }), {
            nil: null,
          }),
          tier: fc.oneof(
            fc.constantFrom(...COURT_TIER_LABELS),
            fc.constant("invalid"),
          ),
          year: fc.integer(),
          count,
          citationSum: fc.option(count, { nil: null }),
          treatment: fc.oneof(fc.constant(null), fc.constant(0)),
        }),
        { maxLength: 3 },
      ),
      truncated: fc.boolean(),
    });
    await assertProperty(
      "HTTP court/year validation agrees with the canonical contract for generated values",
      fc.asyncProperty(fc.oneof(matrix, fc.jsonValue()), async (courtYear) => {
        const response = {
          ...validResponse,
          facets: { ...firstPageFacets, courtYear },
        };
        const valid = v.safeParse(caseLawCourtYearSchema, courtYear).success;
        expect(v.is(searchDecisionsSuccessResponseSchema, response)).toBe(
          valid,
        );
        expect(await httpSends(response)).toBe(valid);
      }),
    );
  });

  // Page one carries the facets; a cursor page carries null, because the
  // counts describe the result set and do not change as a reader pages.
  test("accepts a first page's facets and a cursor page's absence of them", () => {
    expect(
      v.is(searchDecisionsSuccessResponseSchema, {
        ...validResponse,
        facets: firstPageFacets,
      }),
    ).toBe(true);
    expect(
      v.is(searchDecisionsSuccessResponseSchema, {
        ...validResponse,
        facets: null,
        nextCursor: "cursor",
      }),
    ).toBe(true);
  });

  // The type facet is the reader's vocabulary, not the publisher's: a stated
  // spelling or an enum member on the wire is a raw value the web would draw.
  test("the type facet carries canonical kinds and refuses a stated spelling", () => {
    for (const kind of DECISION_TYPE_KINDS) {
      expect(
        v.is(searchDecisionsSuccessResponseSchema, {
          ...validResponse,
          facets: { ...firstPageFacets, decisionType: [bucket(kind)] },
        }),
      ).toBe(true);
    }
    for (const stated of [
      "rozsudek",
      "usn.",
      "ministery_of_justice_decision",
    ]) {
      expect(
        v.is(searchDecisionsSuccessResponseSchema, {
          ...validResponse,
          facets: { ...firstPageFacets, decisionType: [bucket(stated)] },
        }),
      ).toBe(false);
    }
  });

  test("accepts every declared court tier", () => {
    for (const tierLabel of COURT_TIER_LABELS) {
      expect(
        v.is(searchDecisionsSuccessResponseSchema, {
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
  ])("rejects a response outside the declared contract", (response) => {
    expect(v.is(searchDecisionsSuccessResponseSchema, response)).toBe(false);
  });
});

test("every search hit distinguishes a stored document from metadata only", () => {
  for (const textAvailability of ["available", "metadata_only"] as const) {
    const parsed = v.safeParse(searchDecisionsSuccessResponseSchema, {
      ...validResponse,
      hits: validResponse.hits.map((hit) => ({ ...hit, textAvailability })),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.hits.map((hit) => hit.textAvailability)).toEqual([
        textAvailability,
      ]);
    }
  }
  expect(
    v.safeParse(searchDecisionsSuccessResponseSchema, {
      ...validResponse,
      hits: validResponse.hits.map((hit) => ({
        ...hit,
        textAvailability: undefined,
      })),
    }).success,
  ).toBe(false);
});

import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";

import type { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { searchLegislationSuccessResponseSchema } from "@/api/handlers/legislation/search-schema";

type SearchLegislationSuccess = Extract<
  Awaited<ReturnType<typeof searchLegislationHandler>>,
  { items: readonly unknown[] }
>;

const validResponse = {
  items: [
    {
      match: { type: "strict" },
      documentId: "document-id",
      eli: "eli",
      slug: null,
      title: "title",
      country: "XX",
      language: "xx",
      documentType: null,
      status: "status",
      effectiveDate: null,
      versionValidFrom: null,
      versionValidTo: null,
      sourceUrl: null,
      headline: null,
      score: 0,
    },
  ],
  nextCursor: null,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  total: SEARCH_TOTAL_NOT_COUNTED,
} satisfies SearchLegislationSuccess;

describe("legislation search response schema", () => {
  test("matches the handler's complete success payload", () => {
    expectTypeOf<
      v.InferOutput<typeof searchLegislationSuccessResponseSchema>
    >().toEqualTypeOf<SearchLegislationSuccess>();
  });

  test("accepts the complete response", () => {
    expect(v.is(searchLegislationSuccessResponseSchema, validResponse)).toBe(
      true,
    );
  });

  test("rejects a response outside the declared contract", () => {
    expect(
      v.is(searchLegislationSuccessResponseSchema, {
        ...validResponse,
        total: null,
      }),
    ).toBe(false);
  });

  test("sends only the declared fields of a response", () => {
    // The validated output is what leaves the server, so an undeclared field
    // is dropped rather than sent.
    const parsed = v.safeParse(searchLegislationSuccessResponseSchema, {
      ...validResponse,
      unexpected: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.output).toEqual(validResponse);
  });
});

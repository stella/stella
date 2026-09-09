import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { Static } from "elysia";

import { SEARCH_TOTAL_NOT_COUNTED } from "@stll/api-contract/search";

import type { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { searchLegislationSuccessResponseSchema } from "@/api/handlers/legislation/search-schema";

type SearchLegislationSuccess = Extract<
  Awaited<ReturnType<typeof searchLegislationHandler>>,
  { items: readonly unknown[] }
>;

const validResponse = {
  items: [
    {
      documentId: "document-id",
      eli: "eli",
      title: "title",
      country: "XX",
      language: "xx",
      documentType: null,
      status: "status",
      effectiveDate: null,
      sourceUrl: null,
      headline: null,
      score: 0,
    },
  ],
  nextCursor: null,
  total: SEARCH_TOTAL_NOT_COUNTED,
};

describe("legislation search response schema", () => {
  test("matches the handler's complete success payload", () => {
    expectTypeOf<
      Static<typeof searchLegislationSuccessResponseSchema>
    >().toEqualTypeOf<SearchLegislationSuccess>();
  });

  test("accepts the complete response", () => {
    expect(
      Value.Check(searchLegislationSuccessResponseSchema, validResponse),
    ).toBe(true);
  });

  test.each([
    { ...validResponse, total: null },
    { ...validResponse, unexpected: true },
  ])("rejects a response outside the declared contract", (response) => {
    expect(Value.Check(searchLegislationSuccessResponseSchema, response)).toBe(
      false,
    );
  });
});

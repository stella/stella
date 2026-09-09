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
import { searchDecisionsSuccessResponseSchema } from "@/api/handlers/case-law/decisions/search-schema";

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

describe("case-law search response schema", () => {
  test("accepts every complete handler success payload", () => {
    expectTypeOf<HandlerResponseFitsSchema>().toEqualTypeOf<true>();
  });

  test("accepts the complete response", () => {
    expect(
      Value.Check(searchDecisionsSuccessResponseSchema, validResponse),
    ).toBe(true);
  });

  test.each([
    { ...validResponse, total: null },
    { ...validResponse, unexpected: true },
  ])("rejects a response outside the declared contract", (response) => {
    expect(Value.Check(searchDecisionsSuccessResponseSchema, response)).toBe(
      false,
    );
  });
});

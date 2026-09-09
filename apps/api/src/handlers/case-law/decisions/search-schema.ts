import { Type } from "@sinclair/typebox";
import { t } from "elysia";

import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";

import {
  safeHandlerErrorResponseSchema,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

export const searchDecisionsBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
  court: t.Optional(t.String({ maxLength: 512 })),
  country: t.Optional(t.String({ maxLength: 3 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(tSafeId("caseLawSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
});

const nullableStringSchema = t.Union([t.String(), t.Null()]);

const decisionIdentifierSchema = t.Object(
  {
    type: t.Union([
      t.Literal(DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
      t.Literal(DECISION_IDENTIFIER_TYPES.ECLI),
      t.Literal(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION),
      t.Literal(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION),
    ]),
    value: t.String(),
  },
  { additionalProperties: false },
);

// SAFETY: JSON arrays have no readonly marker; the static type keeps the
// canonical non-empty, readonly contract while the schema enforces its bounds.
const decisionIdentifiersSchema = Type.Unsafe<DecisionIdentifiers>(
  t.Array(decisionIdentifierSchema, {
    minItems: 1,
    maxItems: DECISION_IDENTIFIER_MAX_COUNT,
  }),
);

const languageAlternateSchema = t.Object(
  {
    caseNumber: t.String(),
    country: t.String(),
    court: t.String(),
    decisionDate: nullableStringSchema,
    id: t.String(),
    language: t.String(),
    slug: nullableStringSchema,
  },
  { additionalProperties: false },
);

// SAFETY: JSON arrays have no readonly marker; the static type preserves the
// canonical readonly view without copying every result on this search path.
const languageAlternatesSchema = Type.Unsafe<
  readonly PublicDecisionLanguageAlternate[]
>(t.Array(languageAlternateSchema));

const facetValuesSchema = t.Array(
  t.Object(
    {
      value: t.String(),
      count: t.Number(),
    },
    { additionalProperties: false },
  ),
);

export const searchDecisionsSuccessResponseSchema = t.Object(
  {
    hits: t.Array(
      t.Object(
        {
          decisionId: t.String(),
          caseNumber: t.String(),
          slug: nullableStringSchema,
          ecli: nullableStringSchema,
          identifiers: decisionIdentifiersSchema,
          court: t.String(),
          country: t.String(),
          language: t.String(),
          languageAlternates: languageAlternatesSchema,
          decisionDate: nullableStringSchema,
          decisionType: nullableStringSchema,
          sourceUrl: nullableStringSchema,
          headnote: decisionHeadnotePreviewSchema,
          headline: nullableStringSchema,
          anchorId: nullableStringSchema,
          citationCount: t.Number(),
          createdAt: t.String(),
        },
        { additionalProperties: false },
      ),
    ),
    facets: t.Union([
      t.Object(
        {
          court: facetValuesSchema,
          country: facetValuesSchema,
          language: facetValuesSchema,
        },
        { additionalProperties: false },
      ),
      t.Null(),
    ]),
    total: searchTotalSchema,
    nextCursor: nullableStringSchema,
  },
  { additionalProperties: false },
);

export const searchDecisionsResponseSchema = {
  ...safeHandlerResponseSchemas(searchDecisionsSuccessResponseSchema),
  404: t.Union([
    safeHandlerErrorResponseSchema,
    t.Object(
      { error: t.Literal("Not Found") },
      { additionalProperties: false },
    ),
  ]),
};

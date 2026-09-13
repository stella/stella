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
import { COURT_TIER_LABELS } from "@/api/lib/case-law/court-tiers";
import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import { searchSortSchema } from "@/api/lib/case-law/search-sort-schema";
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
  country: t.String({ minLength: 2, maxLength: 3 }),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(tSafeId("caseLawSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
  // A literal union, not `UnionEnum`: Elysia coerces an absent optional
  // `UnionEnum` to its first member, and the handler owns the default.
  sort: t.Optional(searchSortSchema),
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

/**
 * One filter value a reader can narrow to, with how many DECISIONS the query
 * would still return under it. Never a passage count: the corpus index holds
 * several passages per decision, so its counts are cardinalities over the
 * decision id rather than hit counts.
 *
 * `label` is the display name when the value is an identifier the reader
 * should not see (a source id); null when the value is already what a reader
 * reads.
 */
const searchFacetBucketsSchema = t.Array(
  t.Object(
    {
      value: t.String(),
      label: nullableStringSchema,
      count: t.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
);

/**
 * Courts grouped by where they sit in their jurisdiction, apex first: a
 * reader narrowing to "the supreme courts" is doing one thing, not picking
 * names off a flat list of twenty.
 */
const searchCourtTiersSchema = t.Array(
  t.Object(
    {
      tierLabel: t.UnionEnum([...COURT_TIER_LABELS]),
      courts: searchFacetBucketsSchema,
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
          // The stored `ln(1 + weighted citations)` score search ranks by, so
          // a caller can order or threshold on the same number the blend uses.
          citationAuthority: t.Number(),
          // Passages of this decision the query matched, within the scanned
          // window: breadth, not weight. One on the Postgres branch and on an
          // identifier lookup, which score whole decisions.
          matchingPassages: t.Integer({ minimum: 1 }),
          createdAt: t.String(),
        },
        { additionalProperties: false },
      ),
    ),
    // Page one only. The counts describe the whole result set, not the page,
    // so they do not change as a reader pages and are not recomputed.
    facets: t.Union([
      t.Object(
        {
          court: searchCourtTiersSchema,
          year: searchFacetBucketsSchema,
          decisionType: searchFacetBucketsSchema,
          source: searchFacetBucketsSchema,
          language: searchFacetBucketsSchema,
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

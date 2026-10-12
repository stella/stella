import { Type } from "@sinclair/typebox";
import { t } from "elysia";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import {
  caseLawCourtYearSchema,
  type CaseLawCourtYear,
} from "@stll/api-contract/case-law-court-year";
import { DECISION_TYPE_KINDS } from "@stll/api-contract/case-law-decision-types";
import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";
import {
  CASE_LAW_SEARCH_WARNING_CODES,
  FACET_COUNT_TYPE,
  SEARCH_PAGE_REACH,
} from "@stll/api-contract/search";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
  DECISION_PRIMARY_REFERENCE_TYPES,
  type DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";

import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import {
  decisionHeadnotePreviewSchema,
  decisionKeywordsPreviewSchema,
} from "@/api/lib/case-law/decision-headnote-schema";
import { tDecisionPageOffset } from "@/api/lib/case-law/decision-page-offset";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import { searchExcerptSchema } from "@/api/lib/case-law/search-excerpt-schema";
import { searchSortSchema } from "@/api/lib/case-law/search-sort-schema";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { jsonSchemaToTypeBox } from "@/api/lib/json-schema/json-schema-to-typebox";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { tLegalAlternatives } from "@/api/lib/legal-search/legal-alternatives";
import {
  tPublicLawCountry,
  withPublicCountryUnavailable,
} from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { searchPaginationOutcomeSchema } from "@/api/lib/search/pagination-outcome-schema";
import { safePublicHandlerErrorOrStatusTextResponseSchema } from "@/api/lib/search/public-error-response";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

import { CASE_SEARCH_TEXT_BYTES as bytes } from "./search-response-limits";

const courtYearSchema = Type.Unsafe<CaseLawCourtYear>(
  jsonSchemaToTypeBox(toJsonSchema(caseLawCourtYearSchema)),
);

export const searchDecisionsBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(
    tPaginationCursor({
      maxChars: CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
    }),
  ),
  // A page addressed by number: how many ranked results come before it.
  // Exclusive with `cursor`, and `offset + limit` stays within
  // `LIMITS.caseLawResultDepthMax`, so a jump costs one bounded request.
  offset: t.Optional(tDecisionPageOffset()),
  court: t.Optional(t.String({ maxLength: 512 })),
  courts: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: 16,
    }),
  ),
  category: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  hasLegalSentence: t.Optional(t.Boolean()),
  country: tPublicLawCountry,
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(tSafeId("caseLawSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
  // A literal union, not `UnionEnum`: Elysia coerces an absent optional
  // `UnionEnum` to its first member, and the handler owns the default.
  sort: t.Optional(searchSortSchema),
  // How much of the matched passage each hit carries. A name rather than a
  // character count: the window is the search's to choose, and a caller that
  // could ask for arbitrary characters could ask for the whole decision.
  excerpt: t.Optional(searchExcerptSchema),
  // Require every word the query carries, function words included. Off by
  // default: a question asked in a sentence is the common entry, and no
  // judgment is written the way a question is asked. A caller that knows
  // every word matters — a quoted statutory formula, a name — asks for this.
  strict: t.Optional(t.Boolean()),
  // Legal-vocabulary alternatives for the query's words ("kauce" beside
  // "jistota"), as the authenticated expansion endpoint proposed them. ORed in
  // beside each word, never instead of it; ignored under `strict` and for an
  // identifier. Absent, the search matches the words as typed.
  alternatives: t.Optional(tLegalAlternatives),
});

const searchWarningSchema = t.Object(
  {
    code: t.UnionEnum([...CASE_LAW_SEARCH_WARNING_CODES]),
    message: boundedString(bytes.warning),
    hint: boundedString(bytes.warning),
  },
  { additionalProperties: false },
);

const nullableStringSchema = nullableBoundedString(bytes.date);

const decisionIdentifierSchema = t.Object(
  {
    type: t.Union([
      t.Literal(DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
      t.Literal(DECISION_IDENTIFIER_TYPES.ECLI),
      t.Literal(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION),
      t.Literal(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION),
    ]),
    value: boundedString(bytes.identifier),
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
    caseNumber: boundedString(bytes.caseNumber),
    country: boundedString(bytes.country),
    court: boundedString(bytes.court),
    decisionDate: nullableStringSchema,
    id: boundedString(bytes.id),
    language: boundedString(bytes.language),
    slug: nullableBoundedString(bytes.slug),
  },
  { additionalProperties: false },
);

// SAFETY: JSON arrays have no readonly marker; the static type preserves the
// canonical readonly view without copying every result on this search path.
export const languageAlternatesSchema = Type.Unsafe<
  readonly PublicDecisionLanguageAlternate[]
>(
  t.Array(languageAlternateSchema, {
    maxItems: LIMITS.caseLawLanguageAlternatesPerGroupMax,
  }),
);

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
      value: boundedString(bytes.facet),
      label: nullableBoundedString(bytes.label),
      count: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: LIMITS.caseLawYearFacetLimit },
);

/** The type facet: canonical kinds, which the web labels per locale. */
const decisionTypeFacetBucketsSchema = t.Array(
  t.Object(
    {
      value: t.UnionEnum([...DECISION_TYPE_KINDS]),
      label: nullableBoundedString(bytes.label),
      count: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: DECISION_TYPE_KINDS.length },
);

const sourceFacetBucketsSchema = t.Array(
  t.Object(
    {
      value: boundedString(bytes.facet),
      label: nullableBoundedString(bytes.label),
      count: Type.Integer({ minimum: 0 }),
      // Elysia's TypeBox module inference needs a tuple; a mapped array becomes never.
      countType: t.Union([
        t.Literal(FACET_COUNT_TYPE.EXACT),
        t.Literal(FACET_COUNT_TYPE.AT_LEAST),
        t.Literal(FACET_COUNT_TYPE.ESTIMATE),
      ]),
    },
    { additionalProperties: false },
  ),
  { maxItems: LIMITS.caseLawYearFacetLimit },
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
      courts: {
        ...searchFacetBucketsSchema,
        maxItems: LIMITS.caseLawFacetLimit,
      },
    },
    { additionalProperties: false },
  ),
  { maxItems: COURT_TIER_LABELS.length },
);

export const searchDecisionsSuccessResponseSchema = t.Object(
  {
    hits: t.Array(
      t.Object(
        {
          decisionId: boundedString(bytes.id),
          caseNumber: boundedString(bytes.caseNumber),
          /** What kind of reference `caseNumber` is. */
          caseNumberType: t.UnionEnum([...DECISION_PRIMARY_REFERENCE_TYPES]),
          slug: nullableBoundedString(bytes.slug),
          ecli: nullableBoundedString(bytes.identifier),
          identifiers: decisionIdentifiersSchema,
          court: boundedString(bytes.court),
          /**
           * The court's short form, null where nothing states one. A reader
           * scans it; the court name beside it carries the meaning on its own,
           * so an unknown abbreviation is never a placeholder.
           */
          courtAbbreviation: nullableBoundedString(bytes.courtAbbreviation),
          /** Where the court stands, which is what the abbreviation is drawn as. */
          courtTier: t.UnionEnum([...COURT_TIER_LABELS]),
          country: boundedString(bytes.country),
          language: boundedString(bytes.language),
          languageAlternates: languageAlternatesSchema,
          decisionDate: nullableStringSchema,
          decisionType: nullableBoundedString(bytes.decisionType),
          sourceUrl: nullableBoundedString(bytes.sourceUrl),
          headnote: decisionHeadnotePreviewSchema,
          keywords: t.Union([decisionKeywordsPreviewSchema, t.Null()]),
          headline: nullableBoundedString(bytes.headline),
          textWithheldReason: t.Union([
            t.Literal(DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE),
            t.Null(),
          ]),
          anchorId: nullableBoundedString(bytes.anchorId),
          citationCount: t.Number(),
          // The stored `ln(1 + weighted citations)` score search ranks by, so
          // a caller can order or threshold on the same number the blend uses.
          citationAuthority: t.Number(),
          // Passages of this decision the query matched, within the scanned
          // window: breadth, not weight. One on the Postgres branch and on an
          // identifier lookup, which score whole decisions.
          matchingPassages: Type.Integer({ minimum: 1 }),
          createdAt: boundedString(bytes.date),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.caseLawSearchPageSizeMax },
    ),
    // Page one only. The counts describe the whole result set, not the page,
    // so they do not change as a reader pages and are not recomputed.
    facets: t.Union([
      t.Object(
        {
          court: searchCourtTiersSchema,
          courtYear: courtYearSchema,
          year: searchFacetBucketsSchema,
          decisionType: decisionTypeFacetBucketsSchema,
          source: sourceFacetBucketsSchema,
          language: searchFacetBucketsSchema,
        },
        { additionalProperties: false },
      ),
      t.Null(),
    ]),
    total: searchTotalSchema,
    nextCursor: nullableBoundedString(
      CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
    ),
    paginationOutcome: searchPaginationOutcomeSchema,
    /**
     * Whether a page addressed by offset was placed. `scan_budget` means the
     * scan stopped before ranking every result in front of the page: its
     * rows, however few, do not mark the end of the results.
     */
    pageReach: t.Union([
      t.Literal(SEARCH_PAGE_REACH.REACHED),
      t.Literal(SEARCH_PAGE_REACH.SCAN_BUDGET),
    ]),
    /**
     * The query the engine actually answered: the words it required, with a
     * phrase still quoted. Equal in meaning to the request's `query` when
     * nothing was dropped, and always a query that re-runs the same search,
     * so a caller paging or repeating sends this back rather than rebuilding
     * it.
     */
    queryUsed: boundedString(bytes.queryUsed),
    /**
     * What this search answered that the request did not ask for. Empty for
     * a search that required every word and found something.
     */
    warnings: t.Array(searchWarningSchema, {
      maxItems: CASE_LAW_SEARCH_WARNING_CODES.length,
    }),
  },
  { additionalProperties: false },
);

export const searchDecisionsResponseSchema = withPublicCountryUnavailable({
  ...safePublicHandlerResponseSchemasWithStatusText(
    searchDecisionsSuccessResponseSchema,
  ),
  503: safePublicHandlerErrorOrStatusTextResponseSchema,
  404: t.Union([
    safePublicHandlerErrorOrStatusTextResponseSchema,
    t.Object(
      { error: t.Literal("Not Found") },
      { additionalProperties: false },
    ),
  ]),
});

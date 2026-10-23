import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { caseLawCourtYearSchema } from "@stll/api-contract/case-law-court-year";
import { DECISION_TYPE_KINDS } from "@stll/api-contract/case-law-decision-types";
import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";
import {
  CASE_LAW_SEARCH_WARNING_CODES,
  DECISION_SEARCH_MATCHES,
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
import { decisionPageOffsetSchema } from "@/api/lib/case-law/decision-page-offset";
import { caseLawProvisionFilterSchema } from "@/api/lib/case-law/provision-filter";
import { searchExcerptSchema } from "@/api/lib/case-law/search-excerpt-schema";
import { searchSortSchema } from "@/api/lib/case-law/search-sort-schema";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
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

export const searchDecisionsBodySchema = v.object({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
  limit: v.optional(paginationLimitSchema(LIMITS.caseLawSearchPageSizeMax)),
  cursor: v.optional(
    paginationCursorSchema({
      maxChars: CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
    }),
  ),
  // A page addressed by number: how many ranked results come before it.
  // Exclusive with `cursor`, and `offset + limit` stays within
  // `LIMITS.caseLawResultDepthMax`, so a jump costs one bounded request.
  offset: v.optional(decisionPageOffsetSchema()),
  court: v.optional(v.pipe(v.string(), v.maxLength(512))),
  courts: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
      v.minLength(1),
      v.maxLength(16),
    ),
  ),
  category: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  hasLegalSentence: v.optional(v.boolean()),
  // Decisions whose recorded provision links cite this provision. Applied to
  // live rows within the bounded candidate scan, like the metadata filters.
  provision: v.optional(caseLawProvisionFilterSchema),
  country: tPublicLawCountry,
  dateFrom: v.optional(apiDateSchema),
  dateTo: v.optional(apiDateSchema),
  decisionType: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sourceId: v.optional(resourceIdSchema("caseLawSource")),
  language: v.optional(v.pipe(v.string(), v.maxLength(8))),
  // Optional; the handler owns the default.
  sort: v.optional(searchSortSchema),
  // How much of the matched passage each hit carries. A name rather than a
  // character count: the window is the search's to choose, and a caller that
  // could ask for arbitrary characters could ask for the whole decision.
  excerpt: v.optional(searchExcerptSchema),
  // Require every word the query carries, function words included. Off by
  // default: a question asked in a sentence is the common entry, and no
  // judgment is written the way a question is asked. A caller that knows
  // every word matters — a quoted statutory formula, a name — asks for this.
  strict: v.optional(v.boolean()),
  // Legal-vocabulary alternatives for the query's words ("kauce" beside
  // "jistota"), as the authenticated expansion endpoint proposed them. ORed in
  // beside each word, never instead of it; ignored under `strict` and for an
  // identifier. Absent, the search matches the words as typed.
  alternatives: v.optional(tLegalAlternatives),
});

const searchWarningSchema = v.strictObject({
  code: v.picklist([...CASE_LAW_SEARCH_WARNING_CODES]),
  message: boundedString(bytes.warning),
  hint: boundedString(bytes.warning),
});

const nullableStringSchema = nullableBoundedString(bytes.date);

// Every identifier type, read from the table: a new type is answerable the
// day it is stored.
const decisionIdentifierSchema = v.strictObject({
  type: v.picklist(Object.values(DECISION_IDENTIFIER_TYPES)),
  value: boundedString(bytes.identifier),
});

// A tuple with a rest, so the list is non-empty in the type as well as at
// runtime; the transform names the result the canonical readonly contract.
const decisionIdentifiersSchema = v.pipe(
  v.tupleWithRest([decisionIdentifierSchema], decisionIdentifierSchema),
  v.maxLength(DECISION_IDENTIFIER_MAX_COUNT),
  v.transform((identifiers): DecisionIdentifiers => identifiers),
);

const languageAlternateSchema = v.strictObject({
  caseNumber: boundedString(bytes.caseNumber),
  country: boundedString(bytes.country),
  court: boundedString(bytes.court),
  decisionDate: nullableStringSchema,
  id: boundedString(bytes.id),
  language: boundedString(bytes.language),
  slug: nullableBoundedString(bytes.slug),
});

// Readonly, as the canonical view is, so the search path passes the
// alternates through without copying every result.
export const languageAlternatesSchema = v.pipe(
  v.array(languageAlternateSchema),
  v.maxLength(LIMITS.caseLawLanguageAlternatesPerGroupMax),
  v.readonly(),
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
const searchFacetBucketSchema = v.strictObject({
  value: boundedString(bytes.facet),
  label: nullableBoundedString(bytes.label),
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const searchFacetBucketsSchema = v.pipe(
  v.array(searchFacetBucketSchema),
  v.maxLength(LIMITS.caseLawYearFacetLimit),
);

/** The type facet: canonical kinds, which the web labels per locale. */
const decisionTypeFacetBucketsSchema = v.pipe(
  v.array(
    v.strictObject({
      value: v.picklist([...DECISION_TYPE_KINDS]),
      label: nullableBoundedString(bytes.label),
      count: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  v.maxLength(DECISION_TYPE_KINDS.length),
);

const sourceFacetBucketsSchema = v.pipe(
  v.array(
    v.strictObject({
      value: boundedString(bytes.facet),
      label: nullableBoundedString(bytes.label),
      count: v.pipe(v.number(), v.integer(), v.minValue(0)),
      countType: v.union([
        v.literal(FACET_COUNT_TYPE.EXACT),
        v.literal(FACET_COUNT_TYPE.AT_LEAST),
        v.literal(FACET_COUNT_TYPE.ESTIMATE),
      ]),
    }),
  ),
  v.maxLength(LIMITS.caseLawYearFacetLimit),
);

/**
 * Courts grouped by where they sit in their jurisdiction, apex first: a
 * reader narrowing to "the supreme courts" is doing one thing, not picking
 * names off a flat list of twenty.
 */
const searchCourtTiersSchema = v.pipe(
  v.array(
    v.strictObject({
      tierLabel: v.picklist([...COURT_TIER_LABELS]),
      courts: v.pipe(
        v.array(searchFacetBucketSchema),
        v.maxLength(LIMITS.caseLawFacetLimit),
      ),
    }),
  ),
  v.maxLength(COURT_TIER_LABELS.length),
);

export const searchDecisionsSuccessResponseSchema = v.object({
  hits: v.pipe(
    v.array(
      v.object({
        decisionId: boundedString(bytes.id),
        caseNumber: boundedString(bytes.caseNumber),
        /** What kind of reference `caseNumber` is. */
        caseNumberType: v.picklist([...DECISION_PRIMARY_REFERENCE_TYPES]),
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
        courtTier: v.picklist([...COURT_TIER_LABELS]),
        country: boundedString(bytes.country),
        language: boundedString(bytes.language),
        languageAlternates: languageAlternatesSchema,
        decisionDate: nullableStringSchema,
        decisionType: nullableBoundedString(bytes.decisionType),
        sourceUrl: nullableBoundedString(bytes.sourceUrl),
        headnote: decisionHeadnotePreviewSchema,
        keywords: v.union([decisionKeywordsPreviewSchema, v.null()]),
        headline: nullableBoundedString(bytes.headline),
        textWithheldReason: v.union([
          v.literal(DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE),
          v.null(),
        ]),
        anchorId: nullableBoundedString(bytes.anchorId),
        citationCount: v.number(),
        // The stored `ln(1 + weighted citations)` score search ranks by, so
        // a caller can order or threshold on the same number the blend uses.
        citationAuthority: v.number(),
        // Passages of this decision the query matched, within the scanned
        // window: breadth, not weight. One on the Postgres branch and on an
        // identifier lookup, which score whole decisions.
        matchingPassages: v.pipe(v.number(), v.integer(), v.minValue(1)),
        // Whether the decision holds every word of the query, or only some
        // of them: a short first page is topped up with the latter, after
        // every hit of the former.
        match: v.picklist([...DECISION_SEARCH_MATCHES]),
        createdAt: boundedString(bytes.date),
      }),
    ),
    v.maxLength(LIMITS.caseLawSearchPageSizeMax),
  ),
  // Page one only. The counts describe the whole result set, not the page,
  // so they do not change as a reader pages and are not recomputed.
  facets: v.union([
    v.object({
      court: searchCourtTiersSchema,
      courtYear: caseLawCourtYearSchema,
      year: searchFacetBucketsSchema,
      decisionType: decisionTypeFacetBucketsSchema,
      source: sourceFacetBucketsSchema,
      language: searchFacetBucketsSchema,
    }),
    v.null(),
  ]),
  total: searchTotalSchema,
  /** Hits on this page appended by the any-word phase, outside `total`. */
  relaxedHitCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  nextCursor: nullableBoundedString(
    CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  ),
  paginationOutcome: searchPaginationOutcomeSchema,
  /**
   * Whether a page addressed by offset was placed. `scan_budget` means the
   * scan stopped before ranking every result in front of the page: its
   * rows, however few, do not mark the end of the results.
   */
  pageReach: v.union([
    v.literal(SEARCH_PAGE_REACH.REACHED),
    v.literal(SEARCH_PAGE_REACH.SCAN_BUDGET),
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
  warnings: v.pipe(
    v.array(searchWarningSchema),
    v.maxLength(CASE_LAW_SEARCH_WARNING_CODES.length),
  ),
});

export const searchDecisionsResponseSchema = withPublicCountryUnavailable({
  ...safePublicHandlerResponseSchemasWithStatusText(
    searchDecisionsSuccessResponseSchema,
  ),
  503: safePublicHandlerErrorOrStatusTextResponseSchema,
  404: v.union([
    safePublicHandlerErrorOrStatusTextResponseSchema,
    v.object({ error: v.literal("Not Found") }),
  ]),
});

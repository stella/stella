import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { caseLawCourtYearSchema } from "@stll/api-contract/case-law-court-year";
import {
  DECISION_HEADNOTE_KEYWORDS,
  DECISION_TEXT_WITHHELD_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { publicCountryUnavailableSchema } from "@stll/api-contract/public-country-capability";
import {
  CASE_LAW_SEARCH_WARNING_CODES,
  FACET_COUNT_TYPE,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";
import type { SearchTotal } from "@stll/api-contract/search";
import { DECISION_PRIMARY_REFERENCE_TYPES } from "@stll/legal-ast/decision-identifier";

import { AGENT_CASE_LAW_SEARCH_WARNING_CODES } from "../case-law/search-warnings";
import { SEARCH_PAGINATION_OUTCOME_SCHEMA } from "../search/pagination-outcome-projection";
import { CASE_LAW_COURT_PROJECTION } from "./case-law-court-projection";
import {
  passthroughId,
  publicUrl,
  projectionBranch,
} from "./projection-fields";

/**
 * One filter value of the case-law search response, with how many DECISIONS
 * the query still returns under it. `label` carries the display name where the
 * value is an identifier an agent should not show a reader (a source id), and
 * is null where the value already reads as itself.
 */
const caseLawFacetBucketProjection = v.strictObject({
  value: v.string(),
  label: v.nullable(v.string()),
  count: v.number(),
});

/**
 * A source bucket's count is capped, so it says whether it is the exact
 * number, a lower bound, or the index's estimate. Its value is the source's
 * public corpus id, which an agent passes back as `source_id`, never a tenant
 * id, so it is forwarded unchanged like `decisionId`.
 */
const caseLawSourceFacetBucketProjection = v.strictObject({
  ...caseLawFacetBucketProjection.entries,
  value: passthroughId(),
  countType: v.picklist(Object.values(FACET_COUNT_TYPE)),
});

/**
 * Courts grouped by where they sit in their jurisdiction, apex first. The
 * tiers are the ones `court-weights.ts` derives from the seeded rank scale, so
 * an agent narrowing to "the supreme courts" picks a tier rather than guessing
 * which of twenty names outranks which.
 */
const caseLawCourtTierProjection = v.strictObject({
  tierLabel: v.picklist(COURT_TIER_LABELS),
  courts: v.array(caseLawFacetBucketProjection),
});

type CountedSearchTotalType = Extract<
  SearchTotal,
  { readonly count: number }
>["type"];

const countedSearchTotalProjection = (type: CountedSearchTotalType) =>
  v.strictObject({
    type: v.literal(type),
    count: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  });

export const searchTotalProjection = v.variant("type", [
  projectionBranch(countedSearchTotalProjection(SEARCH_TOTAL_TYPE.EXACT)),
  projectionBranch(countedSearchTotalProjection(SEARCH_TOTAL_TYPE.ESTIMATE)),
  projectionBranch(
    v.strictObject({ type: v.literal(SEARCH_TOTAL_TYPE.NOT_COUNTED) }),
  ),
]);

// What `caseNumber` is, present only where it is not a docket: a reporter or
// neutral citation.
export const caseNumberTypeProjection = v.optional(
  v.picklist(DECISION_PRIMARY_REFERENCE_TYPES),
);

const caseLawSearchIdentityFields = {
  // `buildCaseLawDecisionAppUrl` returns null while the public-law surface
  // is disabled (`FEATURE_PUBLIC_LAW`), so the projected shape is
  // nullable; a non-nullable declaration would fail the strict parse and
  // take the tool off the chat surface on any deployment with the flag off.
  appUrl: v.nullable(v.string()),
  url: v.nullable(publicUrl()),
  source_url: v.optional(publicUrl()),
  caseNumber: v.string(),
  citationCount: v.number(),
  // `ln(1 + weighted citations)`, the score the ranking blends in.
  citationAuthority: v.number(),
  country: v.string(),
  ...CASE_LAW_COURT_PROJECTION.entries,
  decisionDate: v.nullable(v.string()),
  decisionId: passthroughId(),
  resourceName: passthroughId(),
  decisionType: v.nullable(v.string()),
  ecli: v.nullable(v.string()),
  language: v.string(),
  // Which of the call's `queries` returned this decision, by index,
  // ascending. A decision several phrasings agree on carries several.
  matchedQueries: v.array(v.number()),
  // Passages of the decision that matched, within the scanned window.
  matchingPassages: v.number(),
  // The publisher's own decision URL, which may embed the publisher's
  // own UUID — never a Stella tenant id, so it is forwarded unchanged.
  sourceUrl: v.nullable(publicUrl()),
} as const;

/**
 * search_case_law. Source of truth: `handleSearchCaseLawTool`
 * (`stella-tools.ts`) merging one `searchDecisionsHandler` page per query.
 * Decision ids are public case-law corpus ids, not tenant refs.
 */
export const SEARCH_CASE_LAW_PROJECTION = v.union([
  projectionBranch(publicCountryUnavailableSchema),
  projectionBranch(
    v.strictObject({
      // Omitted means the page budget excluded headnotes; null is then not an absence claim.
      headnotes: v.picklist(["included", "omitted"]),
      // Facets describe the first phrasing on page one; continuations are null.
      facets: v.nullable(
        v.strictObject({
          court: v.array(caseLawCourtTierProjection),
          courtYear: caseLawCourtYearSchema,
          // Civil years the result set spans, newest first. Empty where the search
          // index cannot answer for them.
          year: v.array(caseLawFacetBucketProjection),
          decisionType: v.array(caseLawFacetBucketProjection),
          // `value` is the source id `search_case_law` accepts as `source_id`.
          source: v.array(caseLawSourceFacetBucketProjection),
          language: v.array(caseLawFacetBucketProjection),
        }),
      ),
      // One query: the engine's own opaque `[score, decisionId]` cursor. Several
      // queries: one sub-cursor per query, base64url-encoded together, so a
      // continuation resumes each query where its own page ended. It carries no
      // memory of what earlier pages emitted, so the deduplication `results`
      // carries is within the page; a caller paging keys on `decisionId`.
      nextCursor: v.nullable(passthroughId()),
      paginationOutcome: v.optional(SEARCH_PAGINATION_OUTCOME_SCHEMA),
      // One entry per `queries[]` entry, in the same order. Per query rather than
      // per call because each phrasing is interpreted on its own: one may carry
      // function words and another none.
      searches: v.array(
        v.strictObject({
          // The phrasing as sent, echoed so a caller reading `searches` alone
          // does not have to hold its own request to know which entry is which.
          query: v.string(),
          // The words this phrasing actually required, itself a valid query:
          // send it back as a `queries` entry to repeat the same search.
          queryUsed: v.string(),
          paginationOutcome: v.optional(SEARCH_PAGINATION_OUTCOME_SCHEMA),
          // What the search answered that the call did not ask for. Empty for a
          // phrasing that required every word it carried and found something.
          warnings: v.array(
            v.strictObject({
              code: v.picklist([
                ...CASE_LAW_SEARCH_WARNING_CODES,
                ...AGENT_CASE_LAW_SEARCH_WARNING_CODES,
              ]),
              message: v.string(),
              hint: v.string(),
            }),
          ),
        }),
      ),
      results: v.array(
        v.union([
          projectionBranch(
            v.strictObject({
              ...caseLawSearchIdentityFields,
              snippet: v.nullable(v.string()),
              // Classifications are not headnotes; when included, null means none was stated.
              keywords: v.nullable(
                v.strictObject({
                  type: v.literal(DECISION_HEADNOTE_KEYWORDS),
                  items: v.array(v.string()),
                  omitted: v.number(),
                }),
              ),
              // Publisher prose uses the expanded reading budget (up to 4000 characters).
              headnote: v.nullable(
                v.strictObject({
                  type: v.literal(TEXT_FIELD_TYPE.PRESENT),
                  text: v.string(),
                  truncated: v.boolean(),
                }),
              ),
            }),
          ),
          projectionBranch(
            v.strictObject({
              ...caseLawSearchIdentityFields,
              excerpt: v.strictObject({
                type: v.literal("withheld"),
                reason: v.literal(DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE),
              }),
              // The licence that withholds the excerpt withholds the source's
              // headnote and classifications too.
              keywords: v.null(),
              headnote: v.null(),
            }),
          ),
        ]),
      ),
      total: searchTotalProjection,
      // Only on an empty result while the organization has no practice
      // jurisdictions: how to set them.
      nextStep: v.optional(v.string()),
    }),
  ),
]);

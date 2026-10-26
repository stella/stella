import * as v from "valibot";

import { SEARCH_SORTS } from "@stll/api-contract/search";

import {
  publicLawPageSearchSchemaUpTo,
  publicLawPageSizeSearchSchema,
} from "@/components/public-law-table/public-law-route-pagination.logic";
import {
  strictSearchValue,
  validDecisionDate,
} from "@/features/case-law/case-law-index-search.logic";
import { CASE_LAW_MAX_PAGE } from "@/features/case-law/case-law-route-pages.logic";
import { searchQuestionsParam } from "@/features/case-law/research/search-questions.logic";
import { optionalUuidSearchSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";
import { optionalLawSearchQuerySchema } from "@/routes/law/-search-query.logic";

const optionalBrowseStringSchema = (maxLength: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  );

/**
 * A calendar date, dropped rather than refused when it is not one: a public
 * URL may be typed or crawled, and a bad date is a page without that bound,
 * not an error screen.
 */
const optionalDateSchema = v.fallback(
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => validDecisionDate(value)),
    ),
  ),
  undefined,
);

/**
 * Whether the search requires every word its query carries. Read leniently
 * like the rest: any spelling but the one the link writes is the default
 * search, which is what a hand-typed or crawled URL gets.
 */
const optionalStrictSchema = v.fallback(
  v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => strictSearchValue(value)),
    ),
  ),
  undefined,
);

export const searchSchema = routeSearchSchema({
  country: optionalBrowseStringSchema(3),
  court: optionalBrowseStringSchema(512),
  from: optionalDateSchema,
  lang: optionalBrowseStringSchema(16),
  // `beforeLoad` applies the selected size's own page bound.
  page: publicLawPageSearchSchemaUpTo(CASE_LAW_MAX_PAGE),
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalLawSearchQuerySchema,
  // The organization's questions this search draws, in order. An id the
  // reader's organization does not hold is not drawn.
  questions: v.fallback(
    v.optional(
      v.pipe(
        v.array(v.string()),
        v.transform((columnIds) => searchQuestionsParam(columnIds)),
      ),
    ),
    undefined,
  ),
  rewrite: v.fallback(v.optional(v.picklist(["off"])), undefined),
  rewrittenFrom: optionalLawSearchQuerySchema,
  sort: v.fallback(v.optional(v.picklist(SEARCH_SORTS)), undefined),
  sourceId: optionalUuidSearchSchema,
  strict: optionalStrictSchema,
  to: optionalDateSchema,
  type: optionalBrowseStringSchema(128),
  // Legacy year links remain readable and resolve to the full year range.
  year: optionalBrowseStringSchema(4),
});

export type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

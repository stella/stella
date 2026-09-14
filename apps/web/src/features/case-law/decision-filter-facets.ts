import {
  decisionFilterFacetsFromBrowse,
  orderCourtTiers,
  yearsNewestFirst,
} from "@/features/case-law/decision-filter-facets.logic";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";
import type {
  CaseLawBrowseFacets,
  SearchFacets,
} from "@/features/case-law/queries/decisions";

/**
 * The one place the served facet shapes are read. Two endpoints answer with
 * facets — a search, which knows what its own result set holds, and the
 * corpus-wide browse listing, which knows what the jurisdiction holds — and
 * the filter popover draws one shape, so the difference is resolved here
 * rather than in the popover's branches.
 */
export const decisionFilterFacets = ({
  browse,
  search,
}: {
  browse: CaseLawBrowseFacets;
  /** Null while browsing, and on a cursor page, which recounts nothing. */
  search: SearchFacets | null;
}): DecisionFilterFacets =>
  search === null
    ? decisionFilterFacetsFromBrowse(browse)
    : {
        courtTiers: orderCourtTiers(search.court),
        year: yearsNewestFirst(search.year),
        decisionType: search.decisionType,
        language: search.language,
      };

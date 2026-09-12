import {
  orderCourtTiers,
  railFacetsFromBrowse,
  yearsNewestFirst,
} from "@/features/case-law/facet-rail.logic";
import type { DecisionRailFacets } from "@/features/case-law/facet-rail.logic";
import type {
  CaseLawBrowseFacets,
  SearchFacets,
} from "@/features/case-law/queries/decisions";

/**
 * The one place the served facet shapes are read. Two endpoints answer with
 * facets — a search, which knows what its own result set holds, and the
 * corpus-wide browse listing, which knows what the jurisdiction holds — and
 * the rail draws one shape, so the difference is resolved here rather than in
 * the rail's branches.
 */
export const railFacets = ({
  browse,
  search,
}: {
  browse: CaseLawBrowseFacets;
  /** Null while browsing, and on a cursor page, which recounts nothing. */
  search: SearchFacets | null;
}): DecisionRailFacets =>
  search === null
    ? railFacetsFromBrowse(browse)
    : {
        courtTiers: orderCourtTiers(search.court),
        year: yearsNewestFirst(search.year),
        decisionType: search.decisionType,
        source: search.source,
        language: search.language,
      };

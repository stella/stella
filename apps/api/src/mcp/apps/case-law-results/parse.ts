import { isLookupResults, isSearchResults } from "../shared/contracts";
import { lookupView, searchView } from "./model";
import type { CaseLawView } from "./model";

type CourtFacets = Extract<CaseLawView, { type: "search" }>["facets"];

export const createCaseLawParser = () => {
  let courtFacets: CourtFacets = null;
  return (
    payload: unknown,
    input: Record<string, unknown>,
  ): CaseLawView | undefined => {
    if (isLookupResults(payload)) {
      return lookupView(payload);
    }
    if (!isSearchResults(payload)) {
      return undefined;
    }
    const view = searchView(payload);
    if (view.type !== "search") {
      return view;
    }
    if (view.facets !== null || typeof input["cursor"] !== "string") {
      courtFacets = view.facets;
      return view;
    }
    // Search facets describe the whole result set and are returned only on page one.
    return {
      type: "search",
      results: view.results,
      facets: courtFacets,
      nextCursor: view.nextCursor,
      searches: view.searches,
      nextStep: view.nextStep,
    };
  };
};

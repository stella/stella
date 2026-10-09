import * as v from "valibot";

import { APP_RESOLVE_SCHEMA, APP_SEARCH_SCHEMA } from "../shared/contracts";
import { resolveView, searchView } from "./model";
import type { CaseLawView } from "./model";

type CourtFacets = Extract<CaseLawView, { type: "search" }>["facets"];

export const createCaseLawParser = () => {
  let courtFacets: CourtFacets = null;
  return (
    payload: unknown,
    input: Record<string, unknown>,
  ): CaseLawView | undefined => {
    const resolution = v.safeParse(APP_RESOLVE_SCHEMA, payload);
    if (resolution.success) {
      return resolveView(resolution.output);
    }
    const search = v.safeParse(APP_SEARCH_SCHEMA, payload);
    if (!search.success) {
      return undefined;
    }
    const view = searchView(search.output);
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

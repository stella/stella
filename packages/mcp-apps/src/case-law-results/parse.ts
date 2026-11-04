import * as v from "valibot";

import {
  APP_COURT_CATALOG_SCHEMA,
  APP_RESOLVE_SCHEMA,
  APP_SEARCH_SCHEMA,
} from "../shared/generated/contracts";
import type { CourtCatalog } from "../shared/generated/contracts";
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
    };
  };
};

/** A `read_case_law_courts` answer, or undefined when it is not one. */
export const parseCourtCatalog = (
  payload: unknown,
): CourtCatalog | undefined => {
  const parsed = v.safeParse(APP_COURT_CATALOG_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};

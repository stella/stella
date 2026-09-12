import { panic } from "better-result";

import { ENTITY_KINDS } from "./entity-kinds";

/**
 * The orders a case-law search may be read in.
 *
 * Here rather than in the API because three surfaces declare it: the search
 * body, the saved query a research table re-runs, and the web that sends both.
 * A table saved under one order has to re-run under it, and a second list of
 * these names is how that stops being true.
 *
 * `relevance` is first because Elysia coerces an absent optional `UnionEnum`
 * to its first member, so slot 0 has to be the default a handler applies.
 */
export const SEARCH_SORTS = ["relevance", "newest"] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export const DEFAULT_SEARCH_SORT = SEARCH_SORTS[0];

export const SEARCH_TOTAL_TYPE = {
  EXACT: "exact",
  ESTIMATE: "estimate",
  NOT_COUNTED: "not_counted",
} as const;

type CountedSearchTotalType =
  | typeof SEARCH_TOTAL_TYPE.EXACT
  | typeof SEARCH_TOTAL_TYPE.ESTIMATE;

export type SearchTotal =
  | {
      readonly type: typeof SEARCH_TOTAL_TYPE.EXACT;
      readonly count: number;
    }
  | {
      readonly type: typeof SEARCH_TOTAL_TYPE.ESTIMATE;
      readonly count: number;
    }
  | { readonly type: typeof SEARCH_TOTAL_TYPE.NOT_COUNTED };

export const SEARCH_TOTAL_NOT_COUNTED = {
  type: SEARCH_TOTAL_TYPE.NOT_COUNTED,
} as const satisfies SearchTotal;

export const countedSearchTotal = (
  type: CountedSearchTotalType,
  count: number,
): SearchTotal => {
  if (!Number.isSafeInteger(count) || count < 0) {
    return panic("A counted search total must be a non-negative safe integer");
  }
  return { type, count };
};

export const GLOBAL_SEARCH_RESULT_TYPES = [
  "matter",
  "contact",
  "case-law",
  ...ENTITY_KINDS,
  // Appended last on purpose: Elysia coerces an absent optional UnionEnum to
  // the first element, so new types must never take slot 0.
  "chat",
] as const;

export type GlobalSearchResultType =
  (typeof GLOBAL_SEARCH_RESULT_TYPES)[number];

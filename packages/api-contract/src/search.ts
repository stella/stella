import { panic } from "better-result";

import { ENTITY_KINDS } from "./entity-kinds";

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

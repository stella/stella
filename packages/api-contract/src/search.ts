import { panic } from "better-result";

import { ENTITY_KINDS } from "./entity-kinds";

/**
 * The orders a case-law search may be read in.
 *
 * Here rather than in the API because two surfaces declare it: the search
 * body and the web that sends it. A second list of these names is how the
 * order a result page was read under stops matching the one it re-reads under.
 *
 * `relevance` is first because Elysia coerces an absent optional `UnionEnum`
 * to its first member, so slot 0 has to be the default a handler applies.
 */
export const SEARCH_SORTS = ["relevance", "newest"] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export const DEFAULT_SEARCH_SORT = SEARCH_SORTS[0];

/**
 * How much of the matched passage a result carries.
 *
 * A name rather than a character count, for the same reason the orders above
 * are names: the reader picks how much of the passage they want to read, and
 * what that costs in characters is the search's business and differs by the
 * engine answering. Here rather than in the API because the search body and
 * the web that sends it both declare it.
 *
 * `short` is first because Elysia coerces an absent optional `UnionEnum` to
 * its first member, so slot 0 has to be the default a handler applies — and
 * it is the size every result has always been shown at.
 */
export const SEARCH_EXCERPTS = ["short", "medium", "long"] as const;

export type SearchExcerpt = (typeof SEARCH_EXCERPTS)[number];

export const DEFAULT_SEARCH_EXCERPT = SEARCH_EXCERPTS[0];

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

/**
 * What a case-law search answered that its caller did not ask for.
 *
 * Here rather than in the API for the same reason the orders above are: both
 * the search response and the web that renders it declare these, and a
 * second list of them is how a warning the API emits stops being a warning
 * the page knows how to show. The wording belongs to each surface — the API
 * writes an agent-facing sentence, the web renders a translated one — so
 * only the codes are shared.
 *
 * - `function_words_optional`: the query carried words that are grammar
 *   rather than subject matter, and did not require them. The response's
 *   `queryUsed` is what it did require.
 * - `no_hits`: nothing matched the words the query required.
 * - `no_hits_filtered`: nothing matched under the filters the request
 *   narrowed with, which is a different answer from `no_hits` because the
 *   caller can drop a filter.
 */
export const CASE_LAW_SEARCH_WARNING_CODES = [
  "function_words_optional",
  "no_hits",
  "no_hits_filtered",
] as const;

export type CaseLawSearchWarningCode =
  (typeof CASE_LAW_SEARCH_WARNING_CODES)[number];

export type CaseLawSearchWarning = {
  readonly code: CaseLawSearchWarningCode;
  /** What happened, in the caller's own terms. */
  readonly message: string;
  /** The concrete next call, never a restatement of the message. */
  readonly hint: string;
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

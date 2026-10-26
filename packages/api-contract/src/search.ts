import { panic } from "better-result";

import { ENTITY_KINDS } from "./entity-kinds";

/**
 * The orders a case-law search may be read in.
 *
 * Here rather than in the API because two surfaces declare it: the search
 * body and the web that sends it. A second list of these names is how the
 * order a result page was read under stops matching the one it re-reads under.
 *
 * `relevance` is first because `DEFAULT_SEARCH_SORT` reads slot 0, the
 * default a handler applies when a search names no order.
 */
export const SEARCH_SORTS = ["relevance", "newest"] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export const DEFAULT_SEARCH_SORT = SEARCH_SORTS[0];

/** Facets offered without the optional court/year matrix. */
export const DEFAULT_CASE_LAW_SEARCH_FACETS = [
  "court",
  "decisionType",
  "source",
  "language",
  "year",
] as const;

export const CASE_LAW_SEARCH_FACET_NAMES = [
  ...DEFAULT_CASE_LAW_SEARCH_FACETS,
  "courtYear",
] as const;

/** Public statute HTTP pages and their web client share the same bound. */
export const PUBLIC_STATUTE_SEARCH_PAGE_SIZE_MAX = 20;

/**
 * How far global search pages, and the ceiling of each facet count. Shared
 * because the web shows a count at this ceiling as "at least", not exact.
 */
export const GLOBAL_SEARCH_RESULT_LIMIT = 1000;

/**
 * How much of the matched passage a result carries.
 *
 * A name rather than a character count, for the same reason the orders above
 * are names: the reader picks how much of the passage they want to read, and
 * what that costs in characters is the search's business and differs by the
 * engine answering. Here rather than in the API because the search body and
 * the web that sends it both declare it.
 *
 * `short` is first because `DEFAULT_SEARCH_EXCERPT` reads slot 0, the
 * default a handler applies — and it is the size every result has always
 * been shown at.
 */
export const SEARCH_EXCERPTS = ["short", "medium", "long"] as const;

export type SearchExcerpt = (typeof SEARCH_EXCERPTS)[number];

export const DEFAULT_SEARCH_EXCERPT = SEARCH_EXCERPTS[0];

/** Whether a decision satisfies every required term or a relaxed partial query. */
export const DECISION_SEARCH_MATCHES = ["all_terms", "some_terms"] as const;

export type DecisionSearchMatch = (typeof DECISION_SEARCH_MATCHES)[number];

/** Match semantics shared by HTTP, MCP and persisted chat projections. */
export const LEGISLATION_SEARCH_MATCH_TYPES = ["strict", "relaxed"] as const;

export const FACET_COUNT_TYPE = {
  EXACT: "exact",
  AT_LEAST: "at-least",
  ESTIMATE: "estimate",
} as const;

export type FacetCountType =
  (typeof FACET_COUNT_TYPE)[keyof typeof FACET_COUNT_TYPE];

export const SEARCH_TOTAL_TYPE = {
  EXACT: "exact",
  ESTIMATE: "estimate",
  NOT_COUNTED: "not_counted",
} as const;

type CountedSearchTotalType =
  typeof SEARCH_TOTAL_TYPE.EXACT | typeof SEARCH_TOTAL_TYPE.ESTIMATE;

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
 * - `partial_matches_appended`: some hits match only part of the required
 *   terms; each hit carries its own match classification.
 * - `no_hits`: nothing matched the words the query required.
 * - `no_hits_filtered`: nothing matched under the filters the request
 *   narrowed with, which is a different answer from `no_hits` because the
 *   caller can drop a filter.
 */
export const CASE_LAW_SEARCH_WARNING_CODES = [
  "function_words_optional",
  "partial_matches_appended",
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
  "chat",
] as const;

export type GlobalSearchResultType =
  (typeof GLOBAL_SEARCH_RESULT_TYPES)[number];

/**
 * Whether a page addressed by offset ranked every result in front of it. A
 * scan that stopped on its budget first could not place the page: its rows,
 * however few, say nothing about where the results end, so a client must not
 * read a short or empty page as the end of the list.
 */
export const SEARCH_PAGE_REACH = {
  REACHED: "reached",
  SCAN_BUDGET: "scan_budget",
} as const;

export type SearchPageReach =
  (typeof SEARCH_PAGE_REACH)[keyof typeof SEARCH_PAGE_REACH];

/** A page can stop before exhaustion when its continuation exceeds a bound. */
export const SEARCH_PAGINATION_COMPLETE = { type: "complete" } as const;
export const SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET = {
  type: "truncated",
  reason: "exclusion_budget",
} as const;

export type SearchPaginationOutcome =
  | typeof SEARCH_PAGINATION_COMPLETE
  | typeof SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET;

/**
 * What follows a page of search results, read from everything the search
 * answered about it. The one place a client decides whether it has seen the
 * whole result set: `complete` only when no cursor follows, the search
 * reached the page, and its outcome is complete. A missing cursor alone
 * proves nothing, since a budget stop ends a scan without one.
 */
export const SEARCH_PAGE_END = {
  /** A cursor follows: results remain. */
  MORE: "more",
  /** No cursor, the page was reached and nothing was truncated: the set ends here. */
  COMPLETE: "complete",
  /** No cursor, but a budget or truncation stopped the scan: results may remain. */
  STOPPED: "stopped",
} as const;

export type SearchPageEnd =
  (typeof SEARCH_PAGE_END)[keyof typeof SEARCH_PAGE_END];

type SearchPageAnswer = {
  nextCursor: unknown;
  reach: SearchPageReach;
  paginationOutcome: { readonly type: string };
};

export const searchPageEnd = ({
  nextCursor,
  paginationOutcome,
  reach,
}: SearchPageAnswer): SearchPageEnd => {
  if (nextCursor !== null) {
    return SEARCH_PAGE_END.MORE;
  }
  return reach === SEARCH_PAGE_REACH.REACHED &&
    paginationOutcome.type === SEARCH_PAGINATION_COMPLETE.type
    ? SEARCH_PAGE_END.COMPLETE
    : SEARCH_PAGE_END.STOPPED;
};

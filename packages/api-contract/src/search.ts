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

/**
 * The orders the case-law browse listing (no query) may be read in: by
 * decision date, either way. A listing has nothing to rank, so relevance is
 * not one of them.
 *
 * `newest` is first because `DEFAULT_DECISION_LIST_SORT` reads slot 0, the
 * order a listing that names none is read in.
 */
export const DECISION_LIST_SORTS = ["newest", "oldest"] as const;

export type DecisionListSort = (typeof DECISION_LIST_SORTS)[number];

export const DEFAULT_DECISION_LIST_SORT = DECISION_LIST_SORTS[0];

/**
 * Every order a case-law results address may name: the search's and the
 * listing's, each once. Which one applies depends on whether the address
 * carries a query.
 */
export const DECISION_SORTS = ["relevance", "newest", "oldest"] as const;

export type DecisionSort = (typeof DECISION_SORTS)[number];

// Both vocabularies, nothing else: an order neither endpoint serves has no
// place in an address, and one an address cannot carry no link can share.
true satisfies SearchSort | DecisionListSort extends DecisionSort
  ? true
  : never;
true satisfies DecisionSort extends SearchSort | DecisionListSort
  ? true
  : never;

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

/**
 * How a case-law page orders its hits, named on the page so every reader
 * (the HTTP search, the agent tools that merge phrasings, the web) applies
 * one order instead of each deciding its own.
 *
 * - `score`: one ranking; a decision lacking a word may stand above one
 *   holding them all when the ranking puts it there.
 * - `all_words_first`: every decision holding all the words, then those
 *   holding some, each group in score order.
 */
export const CASE_LAW_HIT_ORDERS = ["score", "all_words_first"] as const;

export type CaseLawHitOrder = (typeof CASE_LAW_HIT_ORDERS)[number];

/**
 * The order of a page ranked over whole decisions. Pure score until the
 * evaluation of the decision-level generation settles it. A page of the
 * passage generations is `all_words_first` by construction: its partial
 * matches are a second pass appended after the full ones.
 */
export const CASE_LAW_RANKED_HIT_ORDER: CaseLawHitOrder = "score";

/** Which group of an order a hit falls in; lower groups come first. */
export const caseLawHitGroup = (
  match: DecisionSearchMatch,
  order: CaseLawHitOrder,
): number => {
  switch (order) {
    case "score":
      return 0;
    case "all_words_first":
      return match === "some_terms" ? 1 : 0;
    default:
      order satisfies never;
      return panic("Unhandled case-law hit order");
  }
};

/**
 * Hits in `order`, stable within each group. Two groups at most, so two
 * filters rather than a sort: this module also ships to the desktop WebView,
 * whose minimum version has no `Array#toSorted`.
 */
export const orderCaseLawHits = <Hit extends { match: DecisionSearchMatch }>(
  hits: readonly Hit[],
  order: CaseLawHitOrder,
): Hit[] => [
  ...hits.filter((hit) => caseLawHitGroup(hit.match, order) === 0),
  ...hits.filter((hit) => caseLawHitGroup(hit.match, order) !== 0),
];

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
/**
 * A search that ran several phrasings at once returned the ones that finished
 * and stopped the rest on its time budget. Only the agent tools merge
 * phrasings, so only they report it; the HTTP search answers one phrasing and
 * fails whole instead.
 */
export const SEARCH_PAGINATION_TRUNCATED_TIME_BUDGET = {
  type: "truncated",
  reason: "time_budget",
} as const;

/**
 * A case-law first page whose phase for decisions holding only some of the
 * words was due and did not finish. The page holds what the finished phases
 * found, which is not the whole answer: it never ends `complete`, and the
 * agent tools rerun the phrasing from its next cursor.
 */
export const SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET = {
  type: "truncated",
  reason: "partial_matches_budget",
} as const;

export type SearchPaginationOutcome =
  | typeof SEARCH_PAGINATION_COMPLETE
  | typeof SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET;

/** A case-law page: a scan outcome, or partial matches due and unread. */
export type CaseLawSearchPaginationOutcome =
  | SearchPaginationOutcome
  | typeof SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET;

/**
 * How each phase a search was due to run ended. A phase that was not due
 * says so (`not_due`) rather than being left out, so a search that adds a
 * phase cannot report a page end without deciding what that phase did.
 */
export const SEARCH_PHASE_STATES = ["not_due", "finished", "skipped"] as const;

export type SearchPhaseState = (typeof SEARCH_PHASE_STATES)[number];

/**
 * A later phase's end with what its own scan reported: a phase that finished
 * may still have stopped on a budget of its own, and that stop is the page's
 * too.
 */
export type SearchPhaseCompletion =
  | { readonly state: "not_due" }
  | { readonly state: "finished"; readonly outcome: SearchPaginationOutcome }
  | { readonly state: "skipped" };

export const SEARCH_PHASE_NOT_DUE = {
  state: "not_due",
} as const satisfies SearchPhaseCompletion;

/**
 * Every phase's stop, by phase. What a page's outcome is derived from, and
 * only from: `caseLawPageOutcome` is the one function that turns these into
 * a page outcome, and the search response is built from its answer, so no
 * path can call a page complete that a phase did not finish.
 */
export type CaseLawPagePhases = {
  /** How the scan that placed the page ended. */
  readonly scan: SearchPaginationOutcome;
  /** The partial-match pass of the passage generations. */
  readonly partialMatches: SearchPhaseCompletion;
};

/**
 * The outcome a case-law page reports, from every phase. `complete` only
 * when the scan completed and the partial-match pass either was not due or
 * finished complete; any phase's truncation, or a phase skipped, is the
 * page's.
 */
export const caseLawPageOutcome = ({
  scan,
  partialMatches,
}: CaseLawPagePhases): CaseLawSearchPaginationOutcome => {
  switch (partialMatches.state) {
    case "skipped":
      return SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET;
    case "not_due":
      return scan;
    case "finished":
      // The scan's own stop leads: it is the first one the page met.
      return scan.type === SEARCH_PAGINATION_COMPLETE.type
        ? partialMatches.outcome
        : scan;
    default:
      partialMatches satisfies never;
      return panic("Unhandled search phase state");
  }
};

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

/**
 * Whether global search ranked all the chat text matching a query. `partial`
 * means long threads ranked on their leading messages, or matching threads
 * past the ranking window were left out: the other result types are unaffected.
 */
export const GLOBAL_SEARCH_CHAT_COVERAGE = {
  COMPLETE: "complete",
  PARTIAL: "partial",
} as const;

export type GlobalSearchChatCoverage =
  (typeof GLOBAL_SEARCH_CHAT_COVERAGE)[keyof typeof GLOBAL_SEARCH_CHAT_COVERAGE];

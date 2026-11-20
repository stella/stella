import type { RouteRowsPhase } from "@/lib/query-view.logic";

/**
 * What a load can say about the search behind its results: the backend
 * answered it, or could not be reached at all.
 */
export const PUBLIC_LAW_SEARCH_STATE = {
  answered: "answered",
  unavailable: "unavailable",
} as const;

type PublicLawSearchState =
  (typeof PUBLIC_LAW_SEARCH_STATE)[keyof typeof PUBLIC_LAW_SEARCH_STATE];

type PublicLawSearchOutageInput = {
  /** Whether the row query itself reports the backend as unreachable. */
  isQueryOutage: boolean;
  /** Whether the row query holds any page at all, this search's or the last. */
  hasPages: boolean;
  /** What the load that drew this page concluded, once one has. */
  loaded: PublicLawSearchState | undefined;
};

/**
 * Whether the results region stands in for the rows because the search backend
 * could not be reached.
 *
 * A hydrating render reads the load's own conclusion, because the query's
 * failure does not survive the trip from the server: the router's SSR
 * serializer keeps an `Error`'s message and nothing else, so the rehydrated
 * failure is no longer the typed error `isQueryOutage` is read from, and a
 * render trusting the query alone would replace the server's outage with an
 * empty table. A query that answers for itself (a page, or a failure raised in
 * this browser) decides from then on.
 */
export const publicLawSearchOutage = ({
  hasPages,
  isQueryOutage,
  loaded,
}: PublicLawSearchOutageInput): boolean =>
  isQueryOutage ||
  (!hasPages && loaded === PUBLIC_LAW_SEARCH_STATE.unavailable);

/**
 * Whether an action beside the rows may act on the search the URL asks for.
 *
 * Stale rows, and the line above them naming what their search required, are
 * the previous search's while the URL has already moved on. An action offered
 * there reads the URL, so it would run the query whose answer the reader
 * cannot see yet: it is withheld until the rows and the URL are one search
 * again.
 */
export const rowsAnswerRequestedSearch = (phase: RouteRowsPhase): boolean =>
  phase === "rows";

type QueryAnsweredByRowsInput = {
  phase: RouteRowsPhase;
  /** What the URL asks for now. */
  requested: string | undefined;
  /** The term the rows currently on screen were drawn for. */
  shown: string | undefined;
};

/**
 * The query the rows on screen answer.
 *
 * Stale rows were drawn for the search before this one while the URL has
 * already moved on, so the term stays with the rows rather than with the URL:
 * marking a row with words that did not find it, or opening it on them,
 * describes a search the reader is not looking at yet. Every surface that
 * reads a row takes this one value — the marks in its cells, the decision its
 * link opens, the passage a question's source chip jumps to — so none of them
 * can answer a different search than the row beside it.
 */
export const queryAnsweredByRows = ({
  phase,
  requested,
  shown,
}: QueryAnsweredByRowsInput): string | undefined =>
  phase === "stale" ? shown : requested;

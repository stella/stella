/**
 * Whether the results route holds a navigation until its rows arrive.
 *
 * Only the rows are unknown when a reader adds a filter, sorts, or steps a
 * page: the box, the toolbar, the column headers and the pager are all on
 * screen and all still correct. A loader that awaits the new rows takes the whole
 * shell away and gives back a skeleton, so it awaits only when there is
 * nothing to take away.
 */
export type DecisionsLoadMode =
  /** Nothing is on screen: the rows are the page, and the markup lists them. */
  | "await"
  /** A result set is already drawn: the components swap the rows in place. */
  | "background";

type DecisionsLoadModeInput = {
  /** Why the router is loading: `stay` means this match is already rendered. */
  cause: "enter" | "preload" | "stay";
  /** Whether this exact search already has its pages in the query cache. */
  hasCachedPages: boolean;
};

export const decisionsLoadMode = ({
  cause,
  hasCachedPages,
}: DecisionsLoadModeInput): DecisionsLoadMode =>
  hasCachedPages || cause === "stay" ? "background" : "await";

/**
 * Whether the router has this page's rows yet. Both renders are the same page:
 * pending is the page the URL describes, before any row exists.
 */
export type DecisionRouteState = "pending" | "loaded";

/** What the results region shows while the page around it stays put. */
export type DecisionRowsPhase =
  /** There are no rows to draw: the grid stands in skeleton. */
  | "skeleton"
  /** The rows on screen answer the search before this one. */
  | "stale"
  /** The rows answer the search the rest of the page describes. */
  | "rows";

type DecisionRowsPhaseInput = {
  routeState: DecisionRouteState;
  /** Whether the row query has yet to resolve anything for this search. */
  isLoading: boolean;
  /** Whether the rows on screen were kept from the previous search. */
  isPlaceholderData: boolean;
};

/**
 * The rows are the only part of the page that waits, so this is the one place
 * that decides what they show. A pending render and a first fetch are the same
 * thing to the reader — the page is drawn and the grid is empty — and rows are
 * only called stale when there are rows to keep.
 */
export const decisionRowsPhase = ({
  isLoading,
  isPlaceholderData,
  routeState,
}: DecisionRowsPhaseInput): DecisionRowsPhase => {
  if (routeState === "pending" || isLoading) {
    return "skeleton";
  }

  return isPlaceholderData ? "stale" : "rows";
};

/**
 * What a load can say about the search behind its results: the backend
 * answered it, or could not be reached at all.
 */
export const DECISIONS_SEARCH_STATE = {
  answered: "answered",
  unavailable: "unavailable",
} as const;

type DecisionsSearchState =
  (typeof DECISIONS_SEARCH_STATE)[keyof typeof DECISIONS_SEARCH_STATE];

type DecisionsSearchOutageInput = {
  /** Whether the row query itself reports the backend as unreachable. */
  isQueryOutage: boolean;
  /** Whether the row query holds any page at all, this search's or the last. */
  hasPages: boolean;
  /** What the load that drew this page concluded, once one has. */
  loaded: DecisionsSearchState | undefined;
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
export const decisionsSearchOutage = ({
  hasPages,
  isQueryOutage,
  loaded,
}: DecisionsSearchOutageInput): boolean =>
  isQueryOutage || (!hasPages && loaded === DECISIONS_SEARCH_STATE.unavailable);

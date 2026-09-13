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

import { CancelledError } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { panic } from "better-result";

import type { RouteState } from "@/routes/-route-pending-view";

// Preserve TanStack's status/data/error correlation when projecting its result.
type QueryViewQuery<TData, TError> = {
  [Status in UseQueryResult<TData, TError>["status"]]: Pick<
    Extract<UseQueryResult<TData, TError>, { status: Status }>,
    | "status"
    | "fetchStatus"
    | "data"
    | "error"
    | "refetch"
    | "isPlaceholderData"
  >;
}[UseQueryResult<TData, TError>["status"]];

export type QueryView<TData, TError> =
  | { type: "pending" }
  | {
      type: "error";
      error: TError;
      retry: UseQueryResult<TData, TError>["refetch"];
    }
  | { type: "empty" }
  | {
      type: "items";
      items: TData;
      retry: UseQueryResult<TData, TError>["refetch"];
      refetchError?: TError;
    };

export type QueryViewOptions<TData> = {
  isEmpty?: (items: TData) => boolean;
};

export const queryViewError = <TData, TError>(
  view: QueryView<TData, TError>,
): TError | undefined => {
  switch (view.type) {
    case "error":
      return view.error;
    case "items":
      return view.refetchError;
    case "pending":
    case "empty":
      return undefined;
    default:
      view satisfies never;
      return panic("Unhandled query view status");
  }
};

// The full result preserves inference for nested useQuery calls; the projection
// also accepts minimal inputs without weakening status/data/error correlation.
export const queryView = <TData, TError>(
  query: UseQueryResult<TData, TError> | QueryViewQuery<TData, TError>,
  {
    isEmpty = (items) => Array.isArray(items) && items.length === 0,
  }: QueryViewOptions<TData> = {},
): QueryView<TData, TError> => {
  switch (query.status) {
    case "pending":
      return { type: "pending" };
    case "error":
      // Cancellation ends a flight, not the read: keep its data or wait for
      // the next owner instead of promoting navigation to a failure.
      if (query.error instanceof CancelledError) {
        return query.data === undefined
          ? { type: "pending" }
          : { type: "items", items: query.data, retry: query.refetch };
      }
      if (query.data === undefined) {
        return { type: "error", error: query.error, retry: query.refetch };
      }
      // Even cached zero-item data must not turn a failed refetch into empty.
      return {
        type: "items",
        items: query.data,
        retry: query.refetch,
        refetchError: query.error,
      };
    case "success":
      if (isEmpty(query.data)) {
        return query.isPlaceholderData
          ? { type: "pending" }
          : { type: "empty" };
      }
      return { type: "items", items: query.data, retry: query.refetch };
    default:
      query satisfies never;
      return panic("Unhandled query view status");
  }
};

/**
 * Whether a route holds a navigation until its rows arrive.
 *
 * Only the rows are unknown when a user adds a filter, sorts, or steps a
 * page: the box, the toolbar, the column headers and the pager are all on
 * screen and all still correct. A loader that awaits the new rows takes the whole
 * shell away and gives back a skeleton, so it awaits only when there is
 * nothing to take away.
 */
export type RouteLoadMode =
  /** Nothing is on screen: the rows are the page, and the markup lists them. */
  | "await"
  /** A result set is already drawn: the components swap the rows in place. */
  | "background";

type RouteLoadModeInput = {
  /** Why the router is loading: `stay` means this match is already rendered. */
  cause: "enter" | "preload" | "stay";
  /** Whether this exact search already has its pages in the query cache. */
  hasCachedPages: boolean;
};

export const routeLoadMode = ({
  cause,
  hasCachedPages,
}: RouteLoadModeInput): RouteLoadMode =>
  hasCachedPages || cause === "stay" ? "background" : "await";

/** What the results region shows while the page around it stays put. */
export type RouteRowsPhase =
  /** There are no rows to draw: the grid stands in skeleton. */
  | "skeleton"
  /** The rows on screen answer the search before this one. */
  | "stale"
  /** The rows answer the search the rest of the page describes. */
  | "rows";

type RouteRowsPhaseInput = {
  routeState: RouteState;
  /** Whether the row query has yet to resolve anything for this search. */
  isLoading: boolean;
  /** Whether the rows on screen were kept from the previous search. */
  isPlaceholderData: boolean;
  /** How many rows the held page carries; read only while it is held. */
  keptRowCount: number;
};

/**
 * The rows are the only part of the page that waits, so this is the one place
 * that decides what they show. A pending render and a first fetch are the same
 * thing to the reader — the page is drawn and the grid is empty — and rows are
 * only called stale when there are rows to keep.
 *
 * A kept page with no rows keeps nothing: drawn as stale it would be the
 * previous search's "no results" standing over the search still in flight,
 * an answer the new search never gave. Only a settled page may say it is
 * empty, so a held empty page waits in skeleton like a first fetch.
 */
export const routeRowsPhase = ({
  isLoading,
  isPlaceholderData,
  keptRowCount,
  routeState,
}: RouteRowsPhaseInput): RouteRowsPhase => {
  if (routeState === "pending" || isLoading) {
    return "skeleton";
  }
  if (!isPlaceholderData) {
    return "rows";
  }
  return keptRowCount > 0 ? "stale" : "skeleton";
};

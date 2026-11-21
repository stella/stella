/**
 * The order the case-law results are read in, per kind of result set.
 *
 * The URL carries one `sort` for both kinds of page: a search of some words,
 * ranked by relevance or newest first (`SEARCH_SORTS`), and the browse
 * listing, which has nothing to rank and reads newest or oldest first
 * (`DECISION_LIST_SORTS`). An order belongs to the kind that serves it, so
 * the page resolves the URL's order against the kind it shows, and the date
 * column, the toolbar and the heading all read that one resolution.
 */

import { panic } from "better-result";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";
import {
  DECISION_LIST_SORTS,
  DEFAULT_DECISION_LIST_SORT,
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
} from "@stll/api-contract/search";
import type {
  DecisionListSort,
  DecisionSort,
  SearchSort,
} from "@stll/api-contract/search";
import type { SortDirection } from "@stll/workspace-ui/column-sort";

import type {
  SortDirectionAvailability,
  SortDirectionOffers,
} from "@/components/workspaces/properties/sort-property.logic";
import type { TranslationKey } from "@/i18n/types";

/** The two kinds of result set an order is resolved against. */
type DecisionOrderKind = "search" | "browse";

/**
 * Which kind serves each order, as that kind's own value. Total over the URL
 * vocabulary, so a new order does not compile until it says where it applies.
 */
const DECISION_SORT_SERVED_BY = {
  relevance: { search: "relevance", browse: null },
  newest: { search: "newest", browse: "newest" },
  oldest: { search: null, browse: "oldest" },
} as const satisfies Record<
  DecisionSort,
  { search: SearchSort | null; browse: DecisionListSort | null }
>;

/**
 * The order a result set is read in, resolved from what the URL asks.
 *
 * `identity`: a query naming a decision is answered by the identity path,
 * which ranks by relevance whatever the URL asks for, so no order applies.
 */
export type DecisionOrder =
  | { type: "search"; sort: SearchSort }
  | { type: "browse"; sort: DecisionListSort }
  | { type: "identity" };

/** The search order the URL asks for, or the default where it names none. */
export const searchSortOf = (sort: DecisionSort | undefined): SearchSort =>
  (sort === undefined ? null : DECISION_SORT_SERVED_BY[sort].search) ??
  DEFAULT_SEARCH_SORT;

/** The listing order the URL asks for, or the default where it names none. */
export const decisionListSortOf = (
  sort: DecisionSort | undefined,
): DecisionListSort =>
  (sort === undefined ? null : DECISION_SORT_SERVED_BY[sort].browse) ??
  DEFAULT_DECISION_LIST_SORT;

/**
 * The order the page's result set is read in. A URL is typed and shared, so
 * an order the shown kind does not serve (`?q=…&sort=oldest`) reads as that
 * kind's default rather than as an error; the query-edit transition drops it
 * (`sortKeptAcrossQueryEdit`), so the page itself never writes one.
 */
export const decisionOrder = (
  intent: DecisionQueryIntent,
  sort: DecisionSort | undefined,
): DecisionOrder => {
  switch (intent.type) {
    case "empty":
      return { type: "browse", sort: decisionListSortOf(sort) };
    case "text":
      return { type: "search", sort: searchSortOf(sort) };
    case "identifier":
      return { type: "identity" };
    default:
      intent satisfies never;
      return panic(`Unhandled decision query intent: ${String(intent)}`);
  }
};

/**
 * The order a query edit carries into the result set it lands on: kept where
 * that kind serves it, dropped (back to the kind's default) where it does
 * not. Oldest first, chosen on the listing, means nothing to a search.
 */
export const sortKeptAcrossQueryEdit = (
  sort: DecisionSort | undefined,
  query: string | undefined,
): DecisionSort | undefined => {
  if (sort === undefined) {
    return undefined;
  }
  const kind: DecisionOrderKind = query === undefined ? "browse" : "search";
  return DECISION_SORT_SERVED_BY[sort][kind] === null ? undefined : sort;
};

/**
 * The order as the URL carries it: absent while it is the default of the
 * kind the URL shows, so one result set has one canonical address.
 */
export const decisionSortParam = (
  sort: DecisionSort | undefined,
  query: string | undefined,
): DecisionSort | undefined => {
  const defaultSort =
    query === undefined ? DEFAULT_DECISION_LIST_SORT : DEFAULT_SEARCH_SORT;
  return sort === defaultSort ? undefined : sort;
};

/**
 * Which way each order runs over the date column; null for an order that is
 * not by date. Total over each kind's orders, and the only statement of the
 * pairing: the direction a header asks for is read back from these maps.
 */
const SEARCH_SORT_DATE_DIRECTION = {
  relevance: null,
  newest: "desc",
} as const satisfies Record<SearchSort, SortDirection | null>;

const LIST_SORT_DATE_DIRECTION = {
  newest: "desc",
  oldest: "asc",
} as const satisfies Record<DecisionListSort, SortDirection>;

/** Which way the date column orders the rows, or null when it does not. */
export const decisionOrderDateDirection = (
  order: DecisionOrder,
): SortDirection | null => {
  switch (order.type) {
    case "search":
      return SEARCH_SORT_DATE_DIRECTION[order.sort];
    case "browse":
      return LIST_SORT_DATE_DIRECTION[order.sort];
    case "identity":
      return null;
    default:
      order satisfies never;
      return panic(`Unhandled decision order: ${String(order)}`);
  }
};

/**
 * The order a date-column direction asks for in the kind shown, or null when
 * that kind has no order running that way (a search is never oldest first).
 */
export const decisionSortForDateDirection = (
  order: DecisionOrder,
  direction: SortDirection,
): DecisionSort | null => {
  switch (order.type) {
    case "search":
      return (
        SEARCH_SORTS.find(
          (sort) => SEARCH_SORT_DATE_DIRECTION[sort] === direction,
        ) ?? null
      );
    case "browse":
      return (
        DECISION_LIST_SORTS.find(
          (sort) => LIST_SORT_DATE_DIRECTION[sort] === direction,
        ) ?? null
      );
    case "identity":
      return null;
    default:
      order satisfies never;
      return panic(`Unhandled decision order: ${String(order)}`);
  }
};

/**
 * Which ways the date header may order the kind shown: each direction some
 * order of that kind runs in, and the given reason on any other. Null where
 * no order can be chosen at all.
 */
export const decisionDateDirectionOffers = (
  order: DecisionOrder,
  unavailableReason: string,
): SortDirectionOffers | null => {
  if (order.type === "identity") {
    return null;
  }
  const offer = (direction: SortDirection): SortDirectionAvailability =>
    decisionSortForDateDirection(order, direction) === null
      ? { type: "unavailable", reason: unavailableReason }
      : { type: "available" };
  return { asc: offer("asc"), desc: offer("desc") };
};

/**
 * The order the rows were read in, as the date column states it, and how its
 * header asks for another. Date only: it is the one value both the search and
 * the listing order by.
 */
export type DecisionDateOrder = {
  /** Which way the date column orders the rows; null while relevance does. */
  active: SortDirection | null;
  /** Which ways the result set shown can be read, and why not otherwise. */
  directions: SortDirectionOffers;
  onChange: (direction: SortDirection) => void;
};

type DecisionDateOrderOptions = {
  order: DecisionOrder;
  /** Navigates to the result set read in another order. */
  onSortChange: (sort: DecisionSort) => void;
  /** Why the date header cannot order the kind shown some way. */
  unavailableReason: string;
};

/** The date column's part in the order; null where no order can be chosen. */
export const decisionDateOrder = ({
  order,
  onSortChange,
  unavailableReason,
}: DecisionDateOrderOptions): DecisionDateOrder | null => {
  const directions = decisionDateDirectionOffers(order, unavailableReason);
  if (directions === null) {
    return null;
  }
  return {
    active: decisionOrderDateDirection(order),
    directions,
    onChange: (direction) => {
      onSortChange(
        decisionSortForDateDirection(order, direction) ??
          panic(`No ${direction} date order serves this result set`),
      );
    },
  };
};

/** The toolbar's name for each order. */
export const DECISION_SORT_LABEL_KEYS = {
  relevance: "caseLaw.sort.relevance",
  newest: "caseLaw.sort.newest",
  oldest: "caseLaw.sort.oldest",
} as const satisfies Record<DecisionSort, TranslationKey>;

/** The orders the toolbar offers for the kind shown, in the contract's order. */
export const offeredDecisionSorts = (
  order: Exclude<DecisionOrder, { type: "identity" }>,
): readonly DecisionSort[] => {
  switch (order.type) {
    case "search":
      return SEARCH_SORTS;
    case "browse":
      return DECISION_LIST_SORTS;
    default:
      order satisfies never;
      return panic(`Unhandled decision order: ${String(order)}`);
  }
};

/** What the first page of the browse listing is headed with, per order. */
export const DECISION_LIST_HEADING_KEYS = {
  newest: "caseLaw.newestDecisions",
  oldest: "caseLaw.oldestDecisions",
} as const satisfies Record<DecisionListSort, TranslationKey>;

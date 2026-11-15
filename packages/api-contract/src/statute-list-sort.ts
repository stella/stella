/**
 * The orders the public statute list may be read in by one of its columns,
 * as the API and a list address both name them (`amendments-desc`).
 *
 * Every key is a value the list computes per Work rather than one it stores,
 * so an order is served over a set an act year bounds: the list orders that
 * year's acts whole, never a jurisdiction. Without a year the API refuses the
 * order (`STATUTE_LIST_SORT_NEEDS_YEAR_CODE`) instead of reading every Work.
 */

/** The columns the list may be ordered by. */
export const STATUTE_LIST_SORT_KEYS = [
  "actNumber",
  "firstVersion",
  "amendments",
  "lastAmended",
  "citedBy",
] as const;

export type StatuteListSortKey = (typeof STATUTE_LIST_SORT_KEYS)[number];

export const STATUTE_LIST_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type StatuteListSortDirection =
  (typeof STATUTE_LIST_SORT_DIRECTIONS)[number];

export type StatuteListSort =
  `${StatuteListSortKey}-${StatuteListSortDirection}`;

/** What each key holds, which decides how a direction is named and read. */
export const STATUTE_LIST_SORT_KEY_KINDS = {
  actNumber: "number",
  firstVersion: "date",
  amendments: "number",
  lastAmended: "date",
  citedBy: "number",
} as const satisfies Record<StatuteListSortKey, "number" | "date">;

/** Each order as its key and direction; total over every order. */
export const STATUTE_LIST_SORT_ORDERS = {
  "actNumber-asc": { key: "actNumber", direction: "asc" },
  "actNumber-desc": { key: "actNumber", direction: "desc" },
  "firstVersion-asc": { key: "firstVersion", direction: "asc" },
  "firstVersion-desc": { key: "firstVersion", direction: "desc" },
  "amendments-asc": { key: "amendments", direction: "asc" },
  "amendments-desc": { key: "amendments", direction: "desc" },
  "lastAmended-asc": { key: "lastAmended", direction: "asc" },
  "lastAmended-desc": { key: "lastAmended", direction: "desc" },
  "citedBy-asc": { key: "citedBy", direction: "asc" },
  "citedBy-desc": { key: "citedBy", direction: "desc" },
} as const satisfies Record<
  StatuteListSort,
  { key: StatuteListSortKey; direction: StatuteListSortDirection }
>;

/** Every order, in the vocabulary a request and an address carry. */
export const STATUTE_LIST_SORTS = [
  "actNumber-asc",
  "actNumber-desc",
  "firstVersion-asc",
  "firstVersion-desc",
  "amendments-asc",
  "amendments-desc",
  "lastAmended-asc",
  "lastAmended-desc",
  "citedBy-asc",
  "citedBy-desc",
] as const satisfies readonly StatuteListSort[];

// Every order is listed: one missing here could be named but never parsed.
true satisfies StatuteListSort extends (typeof STATUTE_LIST_SORTS)[number]
  ? true
  : never;

/** The order of a key read one way. */
export const statuteListSort = (
  key: StatuteListSortKey,
  direction: StatuteListSortDirection,
): StatuteListSort => `${key}-${direction}`;

/**
 * Whether a list request may be ordered by a column: only over the acts of
 * one year. The API and the list page read this one rule.
 */
export const statuteListSortIsBounded = (filters: {
  year?: number | string | undefined;
}): boolean => filters.year !== undefined;

/** The code a list request ordered by a column without a year is refused with. */
export const STATUTE_LIST_SORT_NEEDS_YEAR_CODE =
  "statute_list_sort_needs_year" as const;

export const STATUTE_LIST_SORT_NEEDS_YEAR_MESSAGE =
  "Ordering the statute list by a column needs a year";

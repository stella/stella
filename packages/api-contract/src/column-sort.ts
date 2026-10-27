/**
 * The vocabulary a table column's order is described in: which kind of value
 * it orders by, and which way. The kind decides how a header names each
 * direction (a date oldest first, a name A to Z, a count lowest first).
 */
export const COLUMN_SORT_KINDS = ["text", "date", "number"] as const;

export type ColumnSortKind = (typeof COLUMN_SORT_KINDS)[number];

/** The two ways a column orders its rows. */
export const SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

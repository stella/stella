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

/**
 * What each direction of each kind is called, in the reader's language: total
 * over both, so every place that names an order (a header's sort items, a
 * view's sort chips) reads its wording from one record the caller translates.
 */
export type SortDirectionLabels = Record<
  ColumnSortKind,
  Record<SortDirection, string>
>;

/** The direction a stored `desc` flag orders in. */
export const sortDirectionOf = (desc: boolean): SortDirection =>
  desc ? "desc" : "asc";

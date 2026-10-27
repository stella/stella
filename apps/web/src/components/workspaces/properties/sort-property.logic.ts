/**
 * What a column header's sort items say and offer.
 *
 * "Ascending" names an operation, not a result: on a date it means oldest
 * first, on a name A to Z, on a count lowest first. Each item is labelled
 * with the order the reader gets, so the label depends on the kind of value
 * the column holds, and every kind states both of its labels here.
 */

import type {
  ColumnSortKind,
  SortDirection,
} from "@stll/api-contract/column-sort";

import type { TranslationKey } from "@/i18n/types";

/**
 * The label of each sort item per kind. Total over the kinds, so a new kind
 * does not compile until it says what each direction means for it.
 */
export const SORT_DIRECTION_LABEL_KEYS = {
  text: {
    asc: "workspaces.properties.sortAscendingText",
    desc: "workspaces.properties.sortDescendingText",
  },
  date: {
    asc: "workspaces.properties.sortAscendingDate",
    desc: "workspaces.properties.sortDescendingDate",
  },
  number: {
    asc: "workspaces.properties.sortAscendingNumber",
    desc: "workspaces.properties.sortDescendingNumber",
  },
} as const satisfies Record<
  ColumnSortKind,
  Record<SortDirection, TranslationKey>
>;

/** Whether a header may order its column one way, and why not when not. */
export type SortDirectionAvailability =
  { type: "available" } | { type: "unavailable"; reason: string };

export type SortDirectionOffers = Record<
  SortDirection,
  SortDirectionAvailability
>;

const AVAILABLE = { type: "available" } as const;

export const ALL_SORT_DIRECTIONS_AVAILABLE = {
  asc: AVAILABLE,
  desc: AVAILABLE,
} as const satisfies SortDirectionOffers;

/**
 * What a header's sort items offer. A column that never orders the rows
 * draws none, rather than two greyed items nothing on the page can enable.
 */
export type ColumnSortOffer =
  | { type: "unordered" }
  | { type: "ordered"; kind: ColumnSortKind; directions: SortDirectionOffers };

export const UNORDERED_COLUMN = {
  type: "unordered",
} as const satisfies ColumnSortOffer;

/** A column of this kind that the reader may order either way. */
export const orderedColumn = (kind: ColumnSortKind): ColumnSortOffer => ({
  type: "ordered",
  kind,
  directions: ALL_SORT_DIRECTIONS_AVAILABLE,
});

/**
 * The order the statute list is read in, as its column headers state it.
 *
 * The URL carries one `order` (`amendments-desc`); the API serves it only over
 * one year's acts (`statuteListSortIsBounded`). The headers read that one
 * rule: with a year they order the list, without one each sort item says why
 * it cannot, and the list keeps its default order.
 */

import type { SortingState } from "@tanstack/react-table";
import { panic } from "better-result";

import {
  STATUTE_LIST_SORT_ORDERS,
  statuteListSort,
  statuteListSortIsBounded,
} from "@stll/api-contract/statute-list-sort";
import type {
  StatuteListSort,
  StatuteListSortKey,
} from "@stll/api-contract/statute-list-sort";
import { sortDirectionOf } from "@stll/workspace-ui/column-sort";
import type { SortDirection } from "@stll/workspace-ui/column-sort";

import { ALL_SORT_DIRECTIONS_AVAILABLE } from "@/components/workspaces/properties/sort-property.logic";
import type { SortDirectionOffers } from "@/components/workspaces/properties/sort-property.logic";
import type { TableSortingLayout } from "@/components/workspaces/table/use-table-state";
import {
  STATUTE_COLUMN_IDS,
  STATUTE_COLUMN_SORT_KEYS,
} from "@/features/statutes/statute-columns.logic";
import type { StatuteColumnId } from "@/features/statutes/statute-columns.logic";

/** The column a key belongs to; every key has exactly one. */
const columnOfSortKey = (key: StatuteListSortKey): StatuteColumnId =>
  STATUTE_COLUMN_IDS.find(
    (column) => STATUTE_COLUMN_SORT_KEYS[column] === key,
  ) ?? panic(`No statute column orders by ${key}`);

/** The column that orders the rows, and which way. */
type ActiveStatuteOrder = { column: StatuteColumnId; direction: SortDirection };

export type StatuteColumnOrder = {
  /** The column ordering the rows, or null while the default order does. */
  active: ActiveStatuteOrder | null;
  /** Which ways a header may order the list shown, and why not otherwise. */
  directions: SortDirectionOffers;
  /** Reads the list in another column order, or back in the default one. */
  onChange: (next: ActiveStatuteOrder | null) => void;
};

type StatuteColumnOrderOptions = {
  sort: StatuteListSort | undefined;
  year: string | undefined;
  /** Navigates to the list read in another order. */
  onSortChange: (sort: StatuteListSort | undefined) => void;
  /** Why a header cannot order the list while no year bounds it. */
  needsYearReason: string;
};

/** The headers' part in the list's order. */
export const statuteColumnOrder = ({
  sort,
  year,
  onSortChange,
  needsYearReason,
}: StatuteColumnOrderOptions): StatuteColumnOrder => {
  const bounded = statuteListSortIsBounded({ year });
  const unavailable = { type: "unavailable", reason: needsYearReason } as const;
  const order =
    sort === undefined || !bounded ? null : STATUTE_LIST_SORT_ORDERS[sort];
  return {
    active:
      order === null
        ? null
        : { column: columnOfSortKey(order.key), direction: order.direction },
    directions: bounded
      ? ALL_SORT_DIRECTIONS_AVAILABLE
      : { asc: unavailable, desc: unavailable },
    onChange: (next) => {
      if (next === null) {
        onSortChange(undefined);
        return;
      }
      const key =
        STATUTE_COLUMN_SORT_KEYS[next.column] ??
        panic(`The statute ${next.column} column has no order`);
      onSortChange(statuteListSort(key, next.direction));
    },
  };
};

const NO_SORTS: SortingState = [];

const isStatuteColumnId = (id: string): id is StatuteColumnId =>
  STATUTE_COLUMN_IDS.some((column) => column === id);

/**
 * The order as the table's sorting state. A header that orders by one column
 * replaces the order; one that clears it returns the list to its default.
 */
export const statuteTableSorting = (
  order: StatuteColumnOrder,
): TableSortingLayout => ({
  sorts:
    order.active === null
      ? NO_SORTS
      : [
          {
            id: order.active.column,
            desc: order.active.direction === "desc",
          },
        ],
  onChange: (sorts) => {
    const first = sorts.at(0);
    if (first === undefined) {
      order.onChange(null);
      return;
    }
    if (!isStatuteColumnId(first.id)) {
      panic(`The statute table sorted by an unknown column: ${first.id}`);
    }
    order.onChange({
      column: first.id,
      direction: sortDirectionOf(first.desc),
    });
  },
});

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  STATUTE_LIST_SORT_ORDERS,
  STATUTE_LIST_SORTS,
} from "@stll/api-contract/statute-list-sort";
import type { StatuteListSort } from "@stll/api-contract/statute-list-sort";

import {
  STATUTE_COLUMN_IDS,
  STATUTE_COLUMN_SORT_KEYS,
} from "@/features/statutes/statute-columns.logic";
import {
  statuteColumnOrder,
  statuteTableSorting,
} from "@/features/statutes/statute-order.logic";

const REASON = "Choose a year";

/** The order a header gesture navigated to, captured. */
const orderAt = (
  sort: StatuteListSort | undefined,
  year: string | undefined,
) => {
  const changes: (StatuteListSort | undefined)[] = [];
  const order = statuteColumnOrder({
    sort,
    year,
    needsYearReason: REASON,
    onSortChange: (next) => changes.push(next),
  });
  return { changes, order };
};

describe("the statute headers' order", () => {
  test("every column order is offered by exactly one header", () => {
    const offered = STATUTE_COLUMN_IDS.flatMap((column) => {
      const key = STATUTE_COLUMN_SORT_KEYS[column];
      return key === null ? [] : [key];
    });
    const keys = STATUTE_LIST_SORTS.map(
      (sort) => STATUTE_LIST_SORT_ORDERS[sort].key,
    );
    expect(offered.toSorted()).toEqual([...new Set(keys)].toSorted());
  });

  test.each(STATUTE_LIST_SORTS.map((sort) => [sort]))(
    "%s reads back as the header that asks for it",
    (sort) => {
      const { changes, order } = orderAt(sort, "2012");
      const active = order.active ?? panic(`${sort} named no active header`);
      expect(STATUTE_COLUMN_SORT_KEYS[active.column]).toBe(
        STATUTE_LIST_SORT_ORDERS[sort].key,
      );
      const sorting = statuteTableSorting(order);
      expect(sorting.sorts).toEqual([
        { id: active.column, desc: active.direction === "desc" },
      ]);
      // The header's own gesture asks for the order it shows.
      sorting.onChange(sorting.sorts);
      expect(changes).toEqual([sort]);
    },
  );

  test("with a year, both directions are on offer", () => {
    const { order } = orderAt(undefined, "2012");
    expect(order.active).toBeNull();
    expect(order.directions).toEqual({
      asc: { type: "available" },
      desc: { type: "available" },
    });
  });

  test("without a year, no direction is, and an order in the address is not shown as applied", () => {
    const { order } = orderAt("amendments-desc", undefined);
    expect(order.active).toBeNull();
    expect(order.directions).toEqual({
      asc: { type: "unavailable", reason: REASON },
      desc: { type: "unavailable", reason: REASON },
    });
    expect(statuteTableSorting(order).sorts).toEqual([]);
  });

  test("a header that clears the order returns the list to its default", () => {
    const { changes, order } = orderAt("citedBy-asc", "2012");
    statuteTableSorting(order).onChange([]);
    expect(changes).toEqual([undefined]);
  });
});

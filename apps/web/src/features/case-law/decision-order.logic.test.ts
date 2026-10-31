import { describe, expect, test } from "bun:test";

import {
  DECISION_LIST_SORTS,
  DECISION_SORTS,
  DEFAULT_DECISION_LIST_SORT,
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
} from "@stll/api-contract/search";
import type { DecisionSort } from "@stll/api-contract/search";
import { SORT_DIRECTIONS } from "@stll/workspace-ui/column-sort";

import {
  decisionDateDirectionOffers,
  decisionDateOrder,
  decisionListSortOf,
  decisionOrder,
  decisionOrderDateDirection,
  decisionSortForDateDirection,
  offeredDecisionSorts,
  searchSortOf,
  sortKeptAcrossQueryEdit,
} from "@/features/case-law/decision-order.logic";
import type { DecisionOrder } from "@/features/case-law/decision-order.logic";

const REASON = "not this way";

/** Every order a result set can be read in, per kind. */
const EVERY_ORDER: readonly DecisionOrder[] = [
  ...SEARCH_SORTS.map((sort) => ({ type: "search" as const, sort })),
  ...DECISION_LIST_SORTS.map((sort) => ({ type: "browse" as const, sort })),
  { type: "identity" },
];

describe("the order a URL resolves to", () => {
  test("is the order it names wherever the result set serves that order", () => {
    for (const sort of SEARCH_SORTS) {
      expect(searchSortOf(sort)).toBe(sort);
    }
    for (const sort of DECISION_LIST_SORTS) {
      expect(decisionListSortOf(sort)).toBe(sort);
    }
  });

  test("is the result set's default for an order it does not serve, or none", () => {
    for (const sort of [undefined, ...DECISION_SORTS]) {
      const search = searchSortOf(sort);
      const list = decisionListSortOf(sort);
      expect(SEARCH_SORTS).toContain(search);
      expect(DECISION_LIST_SORTS).toContain(list);
      if (!SEARCH_SORTS.some((served) => served === sort)) {
        expect(search).toBe(DEFAULT_SEARCH_SORT);
      }
      if (!DECISION_LIST_SORTS.some((served) => served === sort)) {
        expect(list).toBe(DEFAULT_DECISION_LIST_SORT);
      }
    }
  });

  test("follows the kind of query: a listing, a search, or an identity lookup", () => {
    expect(decisionOrder({ type: "empty" }, "oldest")).toEqual({
      type: "browse",
      sort: "oldest",
    });
    expect(decisionOrder({ type: "text", text: "nájem" }, "newest")).toEqual({
      type: "search",
      sort: "newest",
    });
    expect(
      decisionOrder(
        { type: "identifier", kind: "ecli", value: "ECLI:CZ:NS:2026:1" },
        "newest",
      ),
    ).toEqual({ type: "identity" });
  });

  test("a query edit keeps exactly the orders the new result set serves", () => {
    for (const sort of [undefined, ...DECISION_SORTS]) {
      for (const query of [undefined, "nájem"]) {
        const kept = sortKeptAcrossQueryEdit(sort, query);
        const served: readonly DecisionSort[] =
          query === undefined ? DECISION_LIST_SORTS : SEARCH_SORTS;
        expect(kept).toBe(
          sort !== undefined && served.includes(sort) ? sort : undefined,
        );
      }
    }
  });
});

describe("the date column's part in the order", () => {
  test("reads back the order each direction it states came from", () => {
    for (const order of EVERY_ORDER) {
      const direction = decisionOrderDateDirection(order);
      if (direction === null || order.type === "identity") {
        continue;
      }
      expect(decisionSortForDateDirection(order, direction)).toBe(order.sort);
    }
  });

  test("asks only for an order that runs the way it was asked", () => {
    for (const order of EVERY_ORDER) {
      for (const direction of SORT_DIRECTIONS) {
        const sort = decisionSortForDateDirection(order, direction);
        if (sort === null || order.type === "identity") {
          continue;
        }
        const target: DecisionOrder =
          order.type === "search"
            ? { type: "search", sort: searchSortOf(sort) }
            : { type: "browse", sort: decisionListSortOf(sort) };
        expect(decisionOrderDateDirection(target)).toBe(direction);
        expect(offeredDecisionSorts(order)).toContain(sort);
      }
    }
  });

  test("offers both ways on a listing, newest only on a search, nothing on a lookup", () => {
    for (const sort of DECISION_LIST_SORTS) {
      expect(
        decisionDateDirectionOffers({ type: "browse", sort }, REASON),
      ).toEqual({ asc: { type: "available" }, desc: { type: "available" } });
    }
    for (const sort of SEARCH_SORTS) {
      expect(
        decisionDateDirectionOffers({ type: "search", sort }, REASON),
      ).toEqual({
        asc: { type: "unavailable", reason: REASON },
        desc: { type: "available" },
      });
    }
    expect(
      decisionDateDirectionOffers({ type: "identity" }, REASON),
    ).toBeNull();
  });

  test("marks the date column only while a date order is the one shown", () => {
    expect(
      decisionOrderDateDirection({ type: "search", sort: "relevance" }),
    ).toBeNull();
    expect(decisionOrderDateDirection({ type: "search", sort: "newest" })).toBe(
      "desc",
    );
    expect(decisionOrderDateDirection({ type: "browse", sort: "oldest" })).toBe(
      "asc",
    );
  });

  test("a header change navigates to the order that runs that way", () => {
    const asked: DecisionSort[] = [];
    const order = decisionDateOrder({
      order: { type: "browse", sort: "newest" },
      onSortChange: (sort) => {
        asked.push(sort);
      },
      unavailableReason: REASON,
    });
    order?.onChange("asc");
    order?.onChange("desc");
    expect(asked).toEqual(["oldest", "newest"]);
  });
});

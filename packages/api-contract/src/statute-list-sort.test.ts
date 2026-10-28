import { describe, expect, test } from "bun:test";

import {
  STATUTE_LIST_SORT_DIRECTIONS,
  STATUTE_LIST_SORT_KEYS,
  STATUTE_LIST_SORT_ORDERS,
  STATUTE_LIST_SORTS,
  statuteListSort,
  statuteListSortIsBounded,
} from "./statute-list-sort";

describe("statute list column orders", () => {
  test("the vocabulary is every key read either way, each once", () => {
    const named = STATUTE_LIST_SORT_KEYS.flatMap((key) =>
      STATUTE_LIST_SORT_DIRECTIONS.map((direction) =>
        statuteListSort(key, direction),
      ),
    );
    expect(named.toSorted()).toEqual([...STATUTE_LIST_SORTS].toSorted());
    expect(Object.keys(STATUTE_LIST_SORT_ORDERS).toSorted()).toEqual(
      [...STATUTE_LIST_SORTS].toSorted(),
    );
  });

  test.each(STATUTE_LIST_SORTS.map((sort) => [sort]))(
    "%s reads back as the key and direction that name it",
    (sort) => {
      const { key, direction } = STATUTE_LIST_SORT_ORDERS[sort];
      expect(statuteListSort(key, direction)).toBe(sort);
    },
  );

  test("only a year bounds the set a column order is served over", () => {
    expect(statuteListSortIsBounded({ year: 2012 })).toBe(true);
    expect(statuteListSortIsBounded({ year: "2012" })).toBe(true);
    expect(statuteListSortIsBounded({})).toBe(false);
    expect(statuteListSortIsBounded({ year: undefined })).toBe(false);
  });
});

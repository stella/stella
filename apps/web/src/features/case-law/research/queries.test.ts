import { expect, test } from "bun:test";

import { SEARCH_SORTS } from "@stll/api-contract/search";

import {
  decisionFiltersToSavedQuery,
  savedQueryToDecisionFilters,
} from "@/features/case-law/research/queries";

test("legacy research queries acquire the public default country", () => {
  expect(
    savedQueryToDecisionFilters({ query: "synthetic", version: 1 }),
  ).toEqual({
    status: "available",
    filters: { country: "CZE", search: "synthetic" },
  });
});

test("research queries fail closed when their country is unavailable", () => {
  expect(
    savedQueryToDecisionFilters({
      country: "XAA",
      query: "synthetic",
      version: 1,
    }),
  ).toEqual({ status: "unavailable" });
});

test("new research queries persist their public country", () => {
  expect(
    decisionFiltersToSavedQuery({
      country: "CZE",
      search: "synthetic",
    }),
  ).toMatchObject({ country: "CZE" });
});

test("a table saved under an order reopens under it", () => {
  for (const sort of SEARCH_SORTS) {
    const filters = { country: "CZE", search: "synthetic", sort };
    const saved = decisionFiltersToSavedQuery(filters);

    expect(saved.sort).toBe(sort);
    expect(savedQueryToDecisionFilters(saved)).toEqual({
      status: "available",
      filters,
    });
  }
});

test("a table saved without an order stays without one", () => {
  const saved = decisionFiltersToSavedQuery({
    country: "CZE",
    search: "synthetic",
  });

  expect("sort" in saved).toBe(false);
  expect(savedQueryToDecisionFilters(saved)).toEqual({
    status: "available",
    filters: { country: "CZE", search: "synthetic" },
  });
});

test("a legacy table, saved before the order existed, re-runs without one", () => {
  const filters = savedQueryToDecisionFilters({
    query: "synthetic",
    version: 1,
  });

  expect(filters.status).toBe("available");
  expect(filters.status === "available" && "sort" in filters.filters).toBe(
    false,
  );
});

import { expect, test } from "bun:test";

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

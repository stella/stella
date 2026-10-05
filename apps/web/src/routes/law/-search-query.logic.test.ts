import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { optionalLawSearchQuerySchema } from "./-search-query.logic";

describe("law search query validation", () => {
  test("accepts queries above the old UI cap through the API boundary", () => {
    for (const length of [257, SEARCH_QUERY_MAX_LENGTH]) {
      const query = "x".repeat(length);
      expect(v.parse(optionalLawSearchQuerySchema, query)).toBe(query);
    }
    expect(
      v.safeParse(
        optionalLawSearchQuerySchema,
        "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1),
      ).success,
    ).toBe(false);
  });
  test("trims before applying the bound and omits empty queries", () => {
    const query = "x".repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(v.parse(optionalLawSearchQuerySchema, `  ${query}  `)).toBe(query);
    expect(v.parse(optionalLawSearchQuerySchema, "  ")).toBeUndefined();
    expect(v.parse(optionalLawSearchQuerySchema, undefined)).toBeUndefined();
  });
});

import { expect, test } from "bun:test";
import * as v from "valibot";

import { CASE_LAW_SEARCH_FACET_NAMES } from "@stll/api-contract/search";

import { searchCaseLawTexts } from "./case-law-search-guidance";
import { searchCaseLawArgsSchema } from "./case-law-search-input";

test("search input accepts every registered facet and defaults to no facets", () => {
  const schema = searchCaseLawArgsSchema(searchCaseLawTexts("off"));
  const input = { country: "CZE", queries: ["náhrada škody"] };
  expect(v.parse(schema, input).facets).toEqual([]);
  for (const facet of CASE_LAW_SEARCH_FACET_NAMES) {
    expect(v.parse(schema, { ...input, facets: [facet] }).facets).toEqual([
      facet,
    ]);
  }
  expect(
    v.parse(schema, { ...input, facets: [...CASE_LAW_SEARCH_FACET_NAMES] })
      .facets,
  ).toEqual([...CASE_LAW_SEARCH_FACET_NAMES]);
  expect(v.safeParse(schema, { ...input, facets: ["unknown"] }).success).toBe(
    false,
  );
});

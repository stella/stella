import { expect, test } from "bun:test";

import { corpusIndexReadContract } from "@/api/lib/legal-search/corpus-index-read-contract";

test("legacy and final case-law reads use their declared schema", () => {
  expect(corpusIndexReadContract("case_law", "case_law_v4")).toEqual({
    family: "case_law",
    openingPassageQuery: "seq:0",
    yearFacetField: "year",
  });
  expect(corpusIndexReadContract("case_law", "case_law_v5")).toEqual({
    family: "case_law",
    openingPassageQuery: "is_opening:true",
    yearFacetField: "decision_year",
  });
});

test("legislation reads derive the final opening marker", () => {
  expect(corpusIndexReadContract("legislation", "legislation_v1")).toEqual({
    family: "legislation",
    openingPassageQuery: "seq:0",
  });
  expect(corpusIndexReadContract("legislation", "legislation_v2")).toEqual({
    family: "legislation",
    openingPassageQuery: "is_opening:true",
  });
});

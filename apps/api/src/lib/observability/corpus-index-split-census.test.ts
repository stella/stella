import { describe, expect, test } from "bun:test";

import { splitCensusAttributes } from "@/api/lib/observability/corpus-index-split-census";

describe("splitCensusAttributes", () => {
  test("reports the highest count and names every index", () => {
    expect(
      splitCensusAttributes([
        { indexId: "case_law_v7_pol", publishedSplits: 343 },
        { indexId: "case_law_v7_cs_sk", publishedSplits: 450 },
        { indexId: "legislation_v3_cze", publishedSplits: 12 },
      ]),
    ).toEqual({
      maxPublishedSplits: 450,
      servingIndexes: 3,
      splitsByIndex:
        "case_law_v7_pol=343,case_law_v7_cs_sk=450,legislation_v3_cze=12",
    });
  });

  test("reports zero for no indexes rather than negative infinity", () => {
    expect(splitCensusAttributes([]).maxPublishedSplits).toBe(0);
  });
});

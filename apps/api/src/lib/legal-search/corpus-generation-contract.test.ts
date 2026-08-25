import { expect, test } from "bun:test";

import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_STATUSES,
  isCorpusGeneration,
  parseCorpusFamily,
  parseCorpusIndexGenerationStatus,
  parseQuickwitCluster,
  QUICKWIT_CLUSTERS,
  requireQuickwitCluster,
} from "@/api/lib/legal-search/corpus-generation-contract";

test("closed corpus and cluster values parse without a fallback", () => {
  for (const family of CORPUS_FAMILIES) {
    expect(parseCorpusFamily(family)).toBe(family);
  }
  for (const cluster of QUICKWIT_CLUSTERS) {
    expect(parseQuickwitCluster(cluster)).toBe(cluster);
    expect(requireQuickwitCluster(cluster)).toBe(cluster);
  }
  for (const status of CORPUS_INDEX_GENERATION_STATUSES) {
    expect(parseCorpusIndexGenerationStatus(status)).toBe(status);
  }

  expect(parseCorpusFamily("judgments")).toBeNull();
  expect(parseQuickwitCluster("https://internal.example")).toBeNull();
  expect(parseCorpusIndexGenerationStatus("ready")).toBeNull();
  expect(() => requireQuickwitCluster("quickwit_10")).toThrow(
    "Unknown Quickwit cluster reference",
  );
});

test("generation names belong to exactly their declared family", () => {
  expect(isCorpusGeneration("case_law", "case_law_v5")).toBe(true);
  expect(isCorpusGeneration("legislation", "legislation_v2")).toBe(true);
  expect(isCorpusGeneration("case_law", "legislation_v2")).toBe(false);
  expect(isCorpusGeneration("legislation", "case_law_v5")).toBe(false);
  expect(isCorpusGeneration("case_law", "case_law_v0")).toBe(false);
  expect(isCorpusGeneration("case_law", "case_law_v5_preview")).toBe(false);
});

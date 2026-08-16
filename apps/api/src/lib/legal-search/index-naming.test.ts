import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_ID_MAX_LENGTH,
  caseLawCorpusGenerationOrder,
  corpusIndexGeneration,
  corpusIndexId,
  corpusIndexPattern,
  isCaseLawCorpusGeneration,
  tryCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";

test("index id is the generation prefix + lowercased jurisdiction", () => {
  expect(corpusIndexId("case_law_v1", "SVK")).toBe("case_law_v1_svk");
  expect(corpusIndexId("legislation_v1", "cze")).toBe("legislation_v1_cze");
});

test("pattern globs all jurisdiction indexes for a generation", () => {
  expect(corpusIndexPattern("case_law_v1")).toBe("case_law_v1_*");
  expect(corpusIndexPattern("legislation_v1")).toBe("legislation_v1_*");
});

test("rejects a non-alpha jurisdiction (guards against odd index ids)", () => {
  expect(() => corpusIndexId("case_law_v1", "sk droptable")).toThrow(
    "Invalid jurisdiction for corpus index index id: sk droptable",
  );
  expect(() => corpusIndexId("case_law_v1", "")).toThrow(
    "Invalid jurisdiction for corpus index index id: ",
  );
  expect(() => corpusIndexId("case_law_v1", "sk-1")).toThrow(
    "Invalid jurisdiction for corpus index index id: sk-1",
  );
});

test("rejects generations outside the shared storage contract", () => {
  expect(() => corpusIndexId("", "svk")).toThrow(
    "Invalid corpus index generation: ",
  );
  expect(() => corpusIndexId("1_case_law", "svk")).toThrow(
    "Invalid corpus index generation: 1_case_law",
  );
  expect(() =>
    corpusIndexId("x".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH + 1), "svk"),
  ).toThrow("Invalid corpus index generation:");
  expect(() => corpusIndexPattern("case law v1")).toThrow(
    "Invalid corpus index generation: case law v1",
  );
});

test("case-law generation order is canonical and total over its domain", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), (order) => {
      const generation = `case_law_v${order}`;
      expect(isCaseLawCorpusGeneration(generation)).toBe(true);
      expect(caseLawCorpusGenerationOrder(generation)).toBe(order);
    }),
    propertyConfig({ numRuns: 200 }),
  );
  for (const invalid of [
    "case_law_v0",
    "case_law_v01",
    "case_law_v2_suffix",
    "legislation_v2",
    "case_law_v2147483648",
  ]) {
    expect(isCaseLawCorpusGeneration(invalid)).toBe(false);
    expect(caseLawCorpusGenerationOrder(invalid)).toBeNull();
  }
});

test("generation extraction is the inverse of index construction", () => {
  const generationPattern = new RegExp(
    `^[a-z][a-z0-9_]{0,${CORPUS_INDEX_GENERATION_MAX_LENGTH - 1}}$`,
    "u",
  );
  fc.assert(
    fc.property(
      fc.stringMatching(generationPattern),
      fc.stringMatching(/^[a-z]{2,8}$/u),
      (generation, jurisdiction) => {
        const indexId = corpusIndexId(generation, jurisdiction);
        expect(indexId.length).toBeLessThanOrEqual(CORPUS_INDEX_ID_MAX_LENGTH);
        expect(corpusIndexGeneration(indexId)).toBe(generation);
      },
    ),
    propertyConfig({ numRuns: 200 }),
  );
});

test("rejects malformed physical index ids", () => {
  expect(() => corpusIndexGeneration("case_law_v1_12")).toThrow(
    "Invalid corpus index index id: case_law_v1_12",
  );
  expect(() => corpusIndexGeneration("svk")).toThrow(
    "Invalid corpus index index id: svk",
  );
  expect(tryCorpusIndexGeneration("case_law_v1")).toBeNull();
  expect(tryCorpusIndexGeneration("case_law_v1_svk")).toBe("case_law_v1");
});

import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_ID_MAX_LENGTH,
  corpusIndexGeneration,
  corpusIndexId,
  corpusIndexPattern,
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
  expect(() => corpusIndexId("case_law_v1", "sk droptable")).toThrow();
  expect(() => corpusIndexId("case_law_v1", "")).toThrow();
  expect(() => corpusIndexId("case_law_v1", "sk-1")).toThrow();
});

test("rejects generations outside the shared storage contract", () => {
  expect(() => corpusIndexId("", "svk")).toThrow();
  expect(() => corpusIndexId("1_case_law", "svk")).toThrow();
  expect(() =>
    corpusIndexId("x".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH + 1), "svk"),
  ).toThrow();
  expect(() => corpusIndexPattern("case law v1")).toThrow();
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
  expect(() => corpusIndexGeneration("case_law_v1_12")).toThrow();
  expect(() => corpusIndexGeneration("svk")).toThrow();
  expect(tryCorpusIndexGeneration("case_law_v1")).toBeNull();
  expect(tryCorpusIndexGeneration("case_law_v1_svk")).toBe("case_law_v1");
});

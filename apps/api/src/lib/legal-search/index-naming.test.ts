import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  corpusIndexGeneration,
  corpusIndexId,
  corpusIndexPattern,
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

test("generation extraction is the inverse of index construction", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,24}$/u),
      fc.stringMatching(/^[a-z]{2,8}$/u),
      (generation, jurisdiction) => {
        expect(
          corpusIndexGeneration(corpusIndexId(generation, jurisdiction)),
        ).toBe(generation);
      },
    ),
    propertyConfig({ numRuns: 200 }),
  );
});

test("rejects malformed physical index ids", () => {
  expect(() => corpusIndexGeneration("case_law_v1_12")).toThrow();
  expect(() => corpusIndexGeneration("svk")).toThrow();
});

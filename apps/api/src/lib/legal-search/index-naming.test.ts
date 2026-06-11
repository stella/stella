import { expect, test } from "bun:test";

import {
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

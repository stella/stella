import { describe, expect, test } from "bun:test";

import { isExecutableTranslationCombination } from "./contract";

describe("document translation combinations", () => {
  test.each([
    ["translated", "deepl", true],
    ["translated", "ai", true],
    ["bilingual", "ai", true],
    ["bilingual", "deepl", false],
  ] as const)("%s with %s is executable: %s", (output, engine, expected) => {
    expect(isExecutableTranslationCombination(output, engine)).toBe(expected);
  });
});

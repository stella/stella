import { expect, test } from "bun:test";

import {
  assertSameSets,
  characterSets,
  normalizedSet,
} from "../scripts/refresh-exemplar-input";

test("source comparison ignores set spelling but rejects changed character membership", () => {
  expect(normalizedSet("[a-c]")).toBe(normalizedSet("[c a b]"));
  expect(() =>
    assertSameSets({
      expected: { exemplarCharacters: "[a-c]" },
      actual: { exemplarCharacters: "[a b c]" },
    }),
  ).not.toThrow();
  for (const field of ["exemplarCharacters", "auxiliary", "punctuation"]) {
    expect(() =>
      assertSameSets({
        expected: { [field]: "[a]" },
        actual: { [field]: "[b]" },
      }),
    ).toThrow(`Resolved CLDR source differs from npm: ${field}`);
  }
});

test("supplement input rejects missing locales and malformed UnicodeSets", () => {
  expect(() => characterSets({ main: {} }, "aa")).toThrow(
    "CLDR aa has no characters object",
  );
  expect(() =>
    characterSets(
      { main: { aa: { characters: { exemplarCharacters: 7 } } } },
      "aa",
    ),
  ).toThrow("CLDR exemplar must be a UnicodeSet string");
  expect(() => normalizedSet("not a set")).toThrow("Invalid CLDR exemplar");
});

test("resolved primary exemplars must be present but may inherit the empty root set", () => {
  expect(() =>
    characterSets({ main: { blt: { characters: {} } } }, "blt"),
  ).toThrow("CLDR blt has no primary exemplar set");
  // release-49 root.xml declares []; contributed-only resolution can inherit
  // it when a locale's own exemplars remain unconfirmed (for example blt).
  expect(
    characterSets(
      { main: { blt: { characters: { exemplarCharacters: "[]" } } } },
      "blt",
    ),
  ).toEqual({ exemplarCharacters: "[]" });
});

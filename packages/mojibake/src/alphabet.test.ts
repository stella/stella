import { expect, test } from "bun:test";

import { alphabetFor } from "./alphabet.js";
import { CLDR_EXEMPLARS } from "./exemplars.generated.js";

test("every script-qualified exemplar tag resolves to its own exemplars", () => {
  const scripted = Object.keys(CLDR_EXEMPLARS).filter((tag) =>
    /^[a-z]{2,3}-[A-Z][a-z]{3}$/u.test(tag),
  );
  expect(scripted.length).toBeGreaterThan(0);
  for (const tag of scripted) {
    expect(alphabetFor(tag)?.language).toBe(tag);
  }
});

test.each([
  ["pa-PK", "pa-Arab"],
  ["pa-IN", "pa-Guru"],
  ["zh-TW", "zh-Hant"],
  ["zh-HK", "zh-Hant"],
  ["zh-CN", "zh-Hans"],
  ["sr-RS", "sr-Cyrl"],
  ["sr-ME", "sr-Latn"],
  ["uz-AF", "uz-Arab"],
])("a region selects its likely script: %s reads as %s", (region, script) => {
  expect(alphabetFor(region)?.language).toBe(script);
});

test("a tag without script exemplars falls back to the language", () => {
  expect(alphabetFor("cs-CZ")?.language).toBe("cs");
});

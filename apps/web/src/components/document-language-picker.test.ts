import { describe, expect, test } from "bun:test";

import { defaultTargetLanguage } from "./document-language-picker";

describe("document translation target default", () => {
  test.each([
    ["cs", "CS"],
    ["en", "EN-GB"],
    ["pt-BR", "PT-BR"],
    ["unsupported", "EN-GB"],
  ] as const)("maps UI locale %s to %s", (locale, expected) => {
    expect(defaultTargetLanguage(locale)).toBe(expected);
  });
});

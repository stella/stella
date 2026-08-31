import { describe, expect, test } from "bun:test";

import {
  defaultTargetLanguage,
  matchesLanguageQuery,
} from "./document-language-picker.logic";

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

describe("language picker typeahead", () => {
  test("matches the localized name regardless of diacritics", () => {
    const czech = { code: "CS", label: "Čeština" };
    expect(matchesLanguageQuery(czech, "ces")).toBeTrue();
    expect(matchesLanguageQuery(czech, "Češ")).toBeTrue();
    expect(matchesLanguageQuery(czech, "slov")).toBeFalse();
  });

  test("folds letters a mark strip alone would leave standing", () => {
    expect(
      matchesLanguageQuery({ code: "LV", label: "Łotewski" }, "lotewski"),
    ).toBeTrue();
  });

  test("matches on the code, so a known code is enough", () => {
    expect(
      matchesLanguageQuery(
        { code: "PT-BR", label: "Portuguese (Brazilian)" },
        "pt-br",
      ),
    ).toBeTrue();
    expect(
      matchesLanguageQuery(
        { code: "EN-GB", label: "English (British)" },
        "brit",
      ),
    ).toBeTrue();
  });

  test("keeps non-Latin names matchable in their own script", () => {
    expect(
      matchesLanguageQuery({ code: "AR", label: "العربية" }, "العربية"),
    ).toBeTrue();
  });

  test("an empty or whitespace query matches everything", () => {
    const german = { code: "DE", label: "Deutsch" };
    expect(matchesLanguageQuery(german, "")).toBeTrue();
    expect(matchesLanguageQuery(german, "   ")).toBeTrue();
  });
});

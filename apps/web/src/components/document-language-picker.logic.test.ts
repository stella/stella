import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldToAscii } from "@stll/text-normalize";

import {
  defaultTargetLanguage,
  matchesLanguageQuery,
} from "./document-language-picker.logic";

const PROPERTY_TEXT_PARTS_MAX = 24;

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
    expect(
      matchesLanguageQuery({ code: "AR", label: "العَرَبِيَّة" }, "العربيه"),
    ).toBeTrue();
  });

  test("treats the localized label and code as separate searchable fields", () => {
    expect(
      matchesLanguageQuery({ code: "X", label: "Alpha" }, "alpha x"),
    ).toBeFalse();
    expect(
      matchesLanguageQuery({ code: "X", label: "Alpha" }, " alpha "),
    ).toBeTrue();
  });

  test("an empty or whitespace query matches everything", () => {
    const german = { code: "DE", label: "Deutsch" };
    expect(matchesLanguageQuery(german, "")).toBeTrue();
    expect(matchesLanguageQuery(german, "   ")).toBeTrue();
  });

  test("matches malformed labels and queries through the replacement character", () => {
    expect(
      matchesLanguageQuery({ code: "X", label: "A\ud800rabic" }, "\uFFFD"),
    ).toBeTrue();
    expect(
      matchesLanguageQuery({ code: "X", label: "Arabic" }, "\ud800"),
    ).toBeFalse();
  });
});

test("language picker matching preserves the previous folded substring behavior", () => {
  const text = fc
    .array(
      fc.constantFrom(
        "a",
        "A",
        " ",
        "\t",
        "é",
        "e\u0301",
        "Ł",
        "İ",
        "ı",
        "ß",
        "[",
        ".",
        "😀",
        "\ud800",
        "ع",
      ),
      { maxLength: PROPERTY_TEXT_PARTS_MAX },
    )
    .map((parts) => parts.join(""));

  assertProperty(
    "language picker matching preserves the previous folded substring behavior",
    fc.property(
      fc.record({ code: text, label: text }),
      text,
      ({ code, label }, query) => {
        const fold = (value: string) =>
          foldToAscii(value).toLowerCase().toWellFormed();
        const needle = fold(query).trim().toWellFormed();
        const expected =
          needle.length === 0 ||
          fold(label).includes(needle) ||
          fold(code).includes(needle);

        expect(matchesLanguageQuery({ code, label }, query)).toBe(expected);
      },
    ),
  );
});

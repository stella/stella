import { describe, expect, test } from "bun:test";

import {
  displayLanguageName,
  isLanguageCode,
  isUiLocale,
  LANGUAGES,
  resolveUiLocale,
  toLanguageCode,
  UI_LOCALE_DIRECTIONS,
  UI_LANGUAGES,
} from "./index.js";

test("locale directions preserve their public literal types", () => {
  const arabicDirection: "rtl" = UI_LOCALE_DIRECTIONS.ar;
  const englishDirection: "ltr" = UI_LOCALE_DIRECTIONS.en;

  expect(arabicDirection).toBe("rtl");
  expect(englishDirection).toBe("ltr");
});

describe("LANGUAGES", () => {
  test("contains every code exactly once", () => {
    const codes = LANGUAGES.map((language) => language.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("every code is a two-letter lowercase string", () => {
    for (const language of LANGUAGES) {
      expect(language.code).toMatch(/^[a-z]{2}$/u);
    }
  });

  test("covers the full ISO 639-1 living-language range (~180)", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(180);
  });
});

describe("uiAvailable", () => {
  test("every uiAvailable entry carries a non-empty uiLocale", () => {
    for (const language of UI_LANGUAGES) {
      expect(language.uiLocale.length).toBeGreaterThan(0);
    }
  });
});

describe("isUiLocale", () => {
  test("accepts the shipped tags including the regional pt-BR", () => {
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("pt-BR")).toBe(true);
  });

  test("rejects base pt and unknown/non-string inputs", () => {
    expect(isUiLocale("pt")).toBe(false);
    expect(isUiLocale("ja")).toBe(false);
    expect(isUiLocale("")).toBe(false);
    expect(isUiLocale(undefined)).toBe(false);
  });
});

describe("resolveUiLocale", () => {
  test("exact UI tag matches", () => {
    expect(resolveUiLocale("en")).toBe("en");
    expect(resolveUiLocale("pt-BR")).toBe("pt-BR");
  });

  test("normalizes underscores and matches by prefix", () => {
    expect(resolveUiLocale("de_AT")).toBe("de");
    expect(resolveUiLocale("fr-CA")).toBe("fr");
    expect(resolveUiLocale("cs,en-US;q=0.9")).toBe(null);
  });

  test("any pt* variant maps to pt-BR", () => {
    expect(resolveUiLocale("pt")).toBe("pt-BR");
    expect(resolveUiLocale("pt-PT")).toBe("pt-BR");
    expect(resolveUiLocale("pt_BR")).toBe("pt-BR");
  });

  test("unknown locales resolve to null", () => {
    expect(resolveUiLocale("ja")).toBe(null);
    expect(resolveUiLocale("zz")).toBe(null);
    expect(resolveUiLocale("")).toBe(null);
  });
});

describe("isLanguageCode / toLanguageCode", () => {
  test("base codes validate", () => {
    expect(isLanguageCode("pt")).toBe(true);
    expect(isLanguageCode("ja")).toBe(true);
    expect(isLanguageCode("pt-BR")).toBe(false);
    expect(isLanguageCode("zz")).toBe(false);
    expect(isLanguageCode(42)).toBe(false);
  });

  test("canonicalizes regional tags onto base codes", () => {
    expect(toLanguageCode("pt-BR")).toBe("pt");
    expect(toLanguageCode("EN-gb")).toBe("en");
    expect(toLanguageCode("de")).toBe("de");
    expect(toLanguageCode("zz")).toBe(null);
    expect(toLanguageCode("  ")).toBe(null);
  });
});

describe("displayLanguageName", () => {
  test("prefers the endonym by default", () => {
    expect(displayLanguageName("cs")).toBe("Čeština");
    expect(displayLanguageName("pt-BR")).toBe("Português");
  });

  test("can return the English name", () => {
    expect(displayLanguageName("cs", { prefer: "english" })).toBe("Czech");
  });

  test("falls back gracefully for unknown tags", () => {
    // Intl.DisplayNames echoes well-formed-but-unknown tags back; only a
    // structurally malformed tag (Intl throws) hits the upper-case fallback.
    expect(displayLanguageName("zz")).toBe("zz");
    expect(displayLanguageName("!!")).toBe("!!");
  });
});

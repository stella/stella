import { describe, expect, test } from "bun:test";

import { DEEPL_TARGET_LANGUAGES } from "./languages";

const DOCUMENTED_DEEPL_TARGET_CODES = [
  "AR",
  "BG",
  "CS",
  "DA",
  "DE",
  "EL",
  "EN-GB",
  "EN-US",
  "ES",
  "ES-419",
  "ET",
  "FI",
  "FR",
  "HU",
  "ID",
  "IT",
  "JA",
  "KO",
  "LT",
  "LV",
  "NB",
  "NL",
  "PL",
  "PT-BR",
  "PT-PT",
  "RO",
  "RU",
  "SK",
  "SL",
  "SV",
  "TR",
  "UK",
  "ZH",
  "ZH-HANS",
  "ZH-HANT",
] as const;

describe("DeepL target language picker data", () => {
  test("contains every documented DeepL target language code", () => {
    const availableCodes = new Set(
      DEEPL_TARGET_LANGUAGES.map((language) => language.code),
    );

    for (const code of DOCUMENTED_DEEPL_TARGET_CODES) {
      expect(availableCodes.has(code)).toBe(true);
    }
  });

  test("is sorted by display name", () => {
    const displayNames = DEEPL_TARGET_LANGUAGES.map(
      (language) => language.englishName,
    );

    expect(displayNames).toEqual(
      [...displayNames].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
});

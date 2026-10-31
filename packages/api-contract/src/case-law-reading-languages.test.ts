import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_READING_LANGUAGES_MAX,
  caseLawLanguageVersionRank,
  caseLawReadingLanguages,
  parseCaseLawReadingLanguages,
  pickCaseLawLanguageVersion,
} from "./case-law-reading-languages";

const versions = (...languages: string[]) =>
  languages.map((language) => ({ id: `id-${language}`, language }));

describe("the reader's languages", () => {
  test("the UI language, the practice jurisdictions' languages, then French", () => {
    expect(
      caseLawReadingLanguages({ uiLocale: "en", practiceCountries: ["CZ"] }),
    ).toEqual(["en", "cs", "fr"]);
    expect(
      caseLawReadingLanguages({
        uiLocale: "pt-BR",
        practiceCountries: ["be", "SK"],
      }),
    ).toEqual(["pt", "nl", "fr", "de", "sk"]);
  });

  test("a jurisdiction no language is recorded for adds none", () => {
    expect(
      caseLawReadingLanguages({ uiLocale: "cs", practiceCountries: ["ZZ"] }),
    ).toEqual(["cs", "fr"]);
  });

  test("a request's list is normalized, deduplicated and bounded", () => {
    expect(parseCaseLawReadingLanguages("EN,cs,en-GB,,not a tag,fr")).toEqual([
      "en",
      "cs",
      "fr",
    ]);
    expect(parseCaseLawReadingLanguages(undefined)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, index) =>
      String.fromCodePoint(97 + (index % 26), 97 + Math.floor(index / 26)),
    );
    expect(parseCaseLawReadingLanguages(many)).toHaveLength(
      CASE_LAW_READING_LANGUAGES_MAX,
    );
  });
});

describe("the version shown first", () => {
  const reader = { readingLanguages: ["en", "cs", "fr"] } as const;

  test("a reading language beats the language of the case", () => {
    expect(
      pickCaseLawLanguageVersion(versions("bg", "el", "cs", "fr"), {
        ...reader,
        caseLanguage: "el",
      })?.language,
    ).toBe("cs");
  });

  test("French comes before the language of the case", () => {
    expect(
      pickCaseLawLanguageVersion(versions("bg", "el", "fr"), {
        ...reader,
        caseLanguage: "el",
      })?.language,
    ).toBe("fr");
  });

  test("in none of the reader's languages, the language of the case", () => {
    expect(
      pickCaseLawLanguageVersion(versions("bg", "el", "lt"), {
        ...reader,
        caseLanguage: "el",
      })?.language,
    ).toBe("el");
  });

  test("among equals the first listed version stands", () => {
    expect(
      pickCaseLawLanguageVersion(versions("bg", "lt"), reader)?.language,
    ).toBe("bg");
    expect(pickCaseLawLanguageVersion([], reader)).toBeNull();
  });

  test("the rank orders reading languages, then the case's, then the rest", () => {
    const rank = (language: string) =>
      caseLawLanguageVersionRank(language, { ...reader, caseLanguage: "EL" });
    expect(["en-GB", "cs", "fr", "el", "bg"].map(rank)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

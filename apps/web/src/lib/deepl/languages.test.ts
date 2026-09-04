import { describe, expect, test } from "bun:test";

import { compareByLocale } from "@stll/collation";

import { DEEPL_TARGET_LANGUAGES } from "./languages";

describe("DeepL target language picker data", () => {
  test("is sorted by display name", () => {
    const displayNames = DEEPL_TARGET_LANGUAGES.map(
      (language) => language.englishName,
    );

    expect(displayNames).toEqual([...displayNames].sort(compareByLocale("en")));
  });
});

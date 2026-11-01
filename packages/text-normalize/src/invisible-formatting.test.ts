import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { stripInvisibleFormatting } from "./invisible-formatting";

const FORMAT_CHARACTERS = [
  "\u00AD",
  "\u061C",
  "\u200B",
  "\u200E",
  "\u200F",
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2060",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\uFEFF",
];

describe("stripInvisibleFormatting", () => {
  test.each(FORMAT_CHARACTERS)("removes format character %#", (character) => {
    expect(character).toMatch(/\p{Cf}/u);
    expect(stripInvisibleFormatting(`a${character}b.txt`)).toBe("ab.txt");
  });

  test("removes tag characters outside the basic plane", () => {
    expect(stripInvisibleFormatting("a\u{E0041}b")).toBe("ab");
  });

  test.each([
    "Smlouva o dílo č. 12 – příloha.docx",
    "ژاله-قرارداد.pdf",
    "שלום עולם.docx",
    "عقد الإيجار.pdf",
    "می\u200Cخواهم.docx",
    "क्\u200Dष.pdf",
    "👨\u200D👩\u200D👧.txt",
  ])("keeps %s unchanged", (name) => {
    expect(stripInvisibleFormatting(name)).toBe(name);
  });

  test("leaves no format character but the two joiners", () => {
    assertProperty(
      "leaves no format character but the two joiners",
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const stripped = stripInvisibleFormatting(text);
        expect(stripped.replaceAll(/[\u200C\u200D]/gu, "")).not.toMatch(
          /\p{Cf}/u,
        );
        expect(stripInvisibleFormatting(stripped)).toBe(stripped);
      }),
    );
  });
});

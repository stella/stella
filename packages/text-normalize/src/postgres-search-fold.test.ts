import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  findPostgresSearchFoldRanges,
  foldLikePostgresSearch,
  foldLikePostgresSearchWithOffsets,
} from "./postgres-search-fold.js";
import { foldSearchMatchText } from "./search-match.js";

/** The runs of `content` the ranges cover, in order. */
const marked = (content: string, term: string): string[] =>
  findPostgresSearchFoldRanges(content, term).map(({ start, end }) =>
    content.slice(start, end),
  );

describe("foldLikePostgresSearch", () => {
  test("folds Czech, German and French the way a find matches them", () => {
    expect(foldLikePostgresSearch("Antonín Dvořák")).toBe("antonin dvorak");
    expect(foldLikePostgresSearch("JÜRGEN MÜLLER, Straße")).toBe(
      "jurgen muller, strasse",
    );
    expect(foldLikePostgresSearch("Élise Lefèvre")).toBe("elise lefevre");
  });

  test("deletes the combining marks the extension deletes", () => {
    const decomposed = "Dvořák";
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    expect(foldLikePostgresSearch(decomposed)).toBe("dvorak");
  });

  test("expands what the extension expands", () => {
    expect(foldLikePostgresSearch("Æ ½ © ﬁ")).toBe("ae  1/2 (c) fi");
  });

  test("folds full-width wildcards to the ASCII ones", () => {
    expect(foldLikePostgresSearch("５０％＿＼")).toBe("50%_\\");
  });

  test("is narrower than the client search fold", () => {
    // The extension has no rule for `ς` or for marks outside its own set, so
    // a highlight must not fold them either.
    for (const text of ["ΟΔΟΣ ος", "e᷄"]) {
      expect(foldLikePostgresSearch(text)).not.toBe(foldSearchMatchText(text));
    }
    expect(foldLikePostgresSearch("ΟΔΟΣ ος")).toBe("οδοσ ος");
  });

  test("lowers one code point to one, as lower() does", () => {
    // Full lowercasing turns U+0130 into two code points; `lower()` does not,
    // and the extension maps it to `I` before lowering anyway.
    expect("İ".toLowerCase()).toHaveLength(2);
    expect(foldLikePostgresSearch("İstanbul")).toBe("istanbul");
  });
});

describe("foldLikePostgresSearchWithOffsets", () => {
  test("maps every folded unit back to the character it came from", () => {
    const content = "Æ é";
    const folded = foldLikePostgresSearchWithOffsets(content);
    expect(folded.text).toBe("ae e");
    expect(
      folded.originalRanges.map(({ start, end }) => content.slice(start, end)),
    ).toEqual(["Æ", "Æ", " ", "é"]);
  });

  test("a deleted mark joins the character before it", () => {
    const content = "éx";
    const folded = foldLikePostgresSearchWithOffsets(content);
    expect(folded.text).toBe("ex");
    expect(folded.originalRanges.at(0)).toEqual({ start: 0, end: 2 });
  });

  test("folds exactly as the plain fold does", () => {
    assertProperty(
      "folds exactly as the plain fold does",
      fc.property(fc.string({ unit: "binary" }), (content) => {
        expect(foldLikePostgresSearchWithOffsets(content).text).toBe(
          foldLikePostgresSearch(content),
        );
      }),
      propertyConfig(),
    );
  });
});

const FIND_TOKENS = Object.freeze([
  "a",
  "A",
  "e",
  "é",
  "É",
  "́",
  "ř",
  "ß",
  "s",
  "Æ",
  "½",
  "1",
  "İ",
  "i",
  "Σ",
  "ς",
  "％",
  "%",
  " ",
  "😀",
  "\ud800",
]);

const findText = fc
  .array(fc.constantFrom(...FIND_TOKENS), { maxLength: 10 })
  .map((parts) => parts.join(""));

describe("findPostgresSearchFoldRanges", () => {
  test("marks accented text for a plain term, and the other way round", () => {
    expect(marked("Smlouva Dvořák & syn", "dvorak")).toEqual(["Dvořák"]);
    expect(marked("smlouva dvorak", "DVOŘÁK")).toEqual(["dvorak"]);
    expect(marked("Müller GmbH", "MULLER")).toEqual(["Müller"]);
    expect(marked("Élise et Cie", "elise")).toEqual(["Élise"]);
  });

  test("covers a decomposed accent on the last matched letter", () => {
    expect(marked("café noir", "cafe")).toEqual(["café"]);
  });

  test("marks a whole expanded character for a term inside it", () => {
    expect(marked("Æsir", "esi")).toEqual(["Æsi"]);
    expect(marked("Straße", "rass")).toEqual(["raß"]);
  });

  test("marked runs fold to text containing the term, never overlapping", () => {
    assertProperty(
      "marked runs fold to text containing the term, never overlapping",
      fc.property(findText, findText, (content, term) => {
        const needle = foldLikePostgresSearch(term);
        let cursor = 0;
        for (const { start, end } of findPostgresSearchFoldRanges(
          content,
          term,
        )) {
          expect(start).toBeGreaterThanOrEqual(cursor);
          expect(end).toBeGreaterThan(start);
          expect(
            foldLikePostgresSearch(content.slice(start, end)).includes(needle),
          ).toBe(true);
          cursor = end;
        }
      }),
      propertyConfig(),
    );
  });

  test("marks something exactly when the folded text contains the term", () => {
    assertProperty(
      "marks something exactly when the folded text contains the term",
      fc.property(findText, findText, (content, term) => {
        const needle = foldLikePostgresSearch(term);
        fc.pre(needle !== "");
        expect(findPostgresSearchFoldRanges(content, term).length > 0).toBe(
          foldLikePostgresSearch(content).includes(needle),
        );
      }),
      propertyConfig(),
    );
  });
});

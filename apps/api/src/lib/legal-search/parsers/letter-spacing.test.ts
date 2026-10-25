import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { collapseLetterSpacing } from "./letter-spacing";

/** Spell words the way the court emphasises them: letters apart, words wider. */
const spaceOut = (words: readonly string[]): string =>
  words.map((word) => [...word].join(" ")).join("   ");

const czechWord = fc.stringMatching(
  /^[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]{2,12}$/u,
);

describe("letter-spaced emphasis", () => {
  test.each([
    // Verbatim from Pl. ÚS 36/93, I. ÚS 2/93 and Pl. ÚS 36/93's opinions.
    ["N á v r h   s e   z a m í t á .", "Návrh se zamítá."],
    ["Ústavní stížnost se  z a m í t á .", "Ústavní stížnost se zamítá."],
    [
      "ze dne 22. dubna 1992, čj. 11 Co 106/92-64, t a k t o :",
      "ze dne 22. dubna 1992, čj. 11 Co 106/92-64, takto:",
    ],
    ["1.  S T A N O V I S K O", "1. STANOVISKO"],
    ["zrušena, a to z těchto d ů v o d ů :", "zrušena, a to z těchto důvodů:"],
    [
      "P o u č e n í : Proti rozhodnutí Ústavního soudu se nelze odvolat.",
      "Poučení: Proti rozhodnutí Ústavního soudu se nelze odvolat.",
    ],
    ["J M É N E M   R E P U B L I K Y", "JMÉNEM REPUBLIKY"],
  ])("reads %j as %j", (spaced, words) => {
    expect(collapseLetterSpacing(spaced)).toBe(words);
  });

  test("keeps every word boundary of a spaced phrase", () => {
    assertProperty(
      "spaced phrases collapse to their words",
      fc.property(
        fc.array(czechWord, { minLength: 1, maxLength: 5 }),
        (words) => {
          fc.pre(words.some((word) => [...word].length >= 4));
          expect(collapseLetterSpacing(spaceOut(words))).toBe(words.join(" "));
        },
      ),
      { numRuns: 200 },
    );
  });

  test.each([
    "odst. 1 a 2 písm. a) a b)",
    "v § 3 a 4 a v čl. 1",
    "A. M., bytem SRN, a O. M., bytem, SRN",
    "Ústavní  soud  České  republiky",
  ])("leaves ordinary text %j as it is", (text) => {
    expect(collapseLetterSpacing(text)).toBe(text);
  });

  test("is idempotent", () => {
    assertProperty(
      "collapsing twice changes nothing more",
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom(
              "a",
              "b",
              "č",
              "ř",
              "x",
              "slovo",
              "Soud",
              ".",
              ":",
              "1",
              "§",
            ),
            fc.constantFrom(" ", "  ", "   "),
          ),
          { maxLength: 40 },
        ),
        (parts) => {
          const text = parts.map(([token, gap]) => `${token}${gap}`).join("");
          const once = collapseLetterSpacing(text);
          expect(collapseLetterSpacing(once)).toBe(once);
        },
      ),
      { numRuns: 200 },
    );
  });
});

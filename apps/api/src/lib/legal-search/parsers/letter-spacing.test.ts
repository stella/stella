import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { collapseLetterSpacing } from "./letter-spacing";

/** Spell words the way the court emphasises them: letters apart, words wider. */
const spaceOut = (words: readonly string[]): string =>
  words.map((word) => word.split("").join(" ")).join("   ");

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
    // Punctuation set against the last letter rather than spaced from it.
    ["N á v r h   s e   z a m í t á.", "Návrh se zamítá."],
    ["t a k t o:", "takto:"],
    ["z těchto d ů v o d ů:", "z těchto důvodů:"],
    ["O d ů v o d n ě n í :", "Odůvodnění:"],
    // Verbatim from NSS 2 Afs 180/2004 and 2 Afs 154/2005.
    [
      "sp. zn. 31 Ca 51/2004, s e   z r u š u j e   a věc   s e   mu   v r a c í   k dalšímu řízení.",
      "sp. zn. 31 Ca 51/2004, se zrušuje a věc se mu vrací k dalšímu řízení.",
    ],
    [
      "P o u č e n í : Proti tomuto rozsudku   n e j s o u   opravné prostředky přípustné.",
      "Poučení: Proti tomuto rozsudku nejsou opravné prostředky přípustné.",
    ],
  ])("reads %j as %j", (spaced, words) => {
    expect(collapseLetterSpacing(spaced)).toBe(words);
  });

  test("keeps every word boundary of a spaced phrase", () => {
    assertProperty(
      "keeps every word boundary of a spaced phrase",
      fc.property(
        fc.array(czechWord, { minLength: 1, maxLength: 5 }),
        fc.constantFrom("", ".", " .", ":", " :"),
        (words, end) => {
          fc.pre(words.some((word) => word.length >= 4));
          expect(collapseLetterSpacing(`${spaceOut(words)}${end}`)).toBe(
            `${words.join(" ")}${end.trim()}`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test.each([
    "odst. 1 a 2 písm. a) a b)",
    "v § 3 a 4 a v čl. 1",
    "A. M., bytem SRN, a O. M., bytem, SRN",
    "společnosti s r. o. a a. s.",
    "Ústavní  soud  České  republiky",
    // A spaced word elsewhere is no evidence for the prose around it.
    "Soud rozhodoval   i o   nákladech řízení, protože žalobce uspěl.",
  ])("leaves ordinary text %j as it is", (text) => {
    expect(collapseLetterSpacing(text)).toBe(text);
  });

  test("reads the spaced words of mixed prose and emphasis, and only them", () => {
    expect(
      collapseLetterSpacing(
        "Soud rozhodoval   i o   nákladech; návrh se z a m í t á .",
      ),
    ).toBe("Soud rozhodoval   i o   nákladech; návrh se zamítá.");
  });

  test("is idempotent", () => {
    assertProperty(
      "is idempotent",
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

  describe("short words set apart (setApart)", () => {
    test.each([
      // Verbatim from PL. ÚS 15/98 and PL. ÚS 1/2021.
      [
        "zákonov   n i e   j e   v súlade s čl. 26",
        "zákonov nie je v súlade s čl. 26",
      ],
      ["zákona  n i e  sú   v  súlade", "zákona nie sú   v  súlade"],
    ])("reads %j as %j", (spaced, words) => {
      expect(collapseLetterSpacing(spaced, { setApart: true })).toBe(words);
      // Off by default: the Czech court spaces no word this short alone.
      expect(collapseLetterSpacing(spaced)).toBe(spaced);
    });

    test.each([
      // A row of one-letter words, an initial, an abbreviation.
      "slobôd  a v  súlade",
      "úrad   v L.   o podanie",
      "zákona   a č.   2",
    ])("leaves %j as it is", (text) => {
      expect(collapseLetterSpacing(text, { setApart: true })).toBe(text);
    });
  });
});

test("ordinary one-letter words beside spaced emphasis remain separate", () => {
  expect(collapseLetterSpacing("rozhodl   i o   z a m í t á")).toBe(
    "rozhodl   i o zamítá",
  );
  expect(collapseLetterSpacing("s e   mu   v r a c í")).toBe("se mu vrací");
});

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { collapseLetterSpacing, documentWordCounts } from "./letter-spacing.js";
import { normalizeUnicode } from "./unicode.js";

/** Spell words the way the court emphasises them: letters apart, words wider. */
const spaceOut = (words: readonly string[]): string =>
  words.map((word) => word.split("").join(" ")).join("   ");

const czechWord = fc.stringMatching(
  /^[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]{2,12}$/u,
);

test("attested uneven chunks retain ordinary word boundaries", () => {
  const options = {
    setApart: true,
    documentWords: documentWordCounts(["vylúčený dokonca avzoski"]),
    spacedWords: new Set(["rozhodol", "odôvodnenie", "poučenie"]),
  };
  expect(collapseLetterSpacing("vy l ú čen ý", options)).toBe("vylúčený");
  expect(collapseLetterSpacing("rozh od ol :", options)).toBe("rozhodol:");
  expect(collapseLetterSpacing("O d ôvod n eni e:", options)).toBe(
    "Odôvodnenie:",
  );
  expect(collapseLetterSpacing("Pou čen i e:", options)).toBe("Poučenie:");
  for (const text of [
    // A row of one-letter words a sentence writes: conjunctions, then one.
    "a i a v",
    "do konca",
    "v znení",
    "a i",
    "o s",
    "k i",
  ]) {
    expect(collapseLetterSpacing(text, options)).toBe(text);
  }
  // No witness, but the pieces are no words: a fragment (`l`, `á`), pieces
  // the document prints nowhere else, up to the end of the text.
  expect(collapseLetterSpacing("vy l ú čen á", options)).toBe("vylúčená");
});

test("uneven attested spacing ignores chunk and Unicode boundaries", () => {
  assertProperty(
    "uneven attested spacing ignores chunk and Unicode boundaries",
    fc.property(
      fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
      fc.constantFrom("NFC", "NFD"),
      (cuts, normalization) => {
        const letters = Array.from("vylúčen");
        let spaced = "";
        for (const [index, letter] of letters.entries()) {
          spaced += letter + (cuts[index] === true ? " " : "");
        }
        spaced = normalizeUnicode(`${spaced.trimEnd()} ý`, normalization);
        const options = {
          setApart: true,
          documentWords: documentWordCounts(["vylúčený"]),
        };
        const result = collapseLetterSpacing(spaced, options);
        expect(normalizeUnicode(result, "NFC")).toBe("vylúčený");
        expect(collapseLetterSpacing(result, options)).toBe(result);
      },
    ),
  );
});

test("ordinary one-letter words retain every separator and punctuation", () => {
  assertProperty(
    "ordinary one-letter words retain every separator and punctuation",
    fc.property(
      // A row a sentence writes: conjunctions, then any one-letter word.
      fc
        .tuple(
          fc.array(fc.constantFrom("a", "i"), { minLength: 1, maxLength: 11 }),
          fc.constantFrom("a", "v", "w", "z", "o", "s", "k", "i", "u"),
        )
        .map(([conjunctions, last]) => [...conjunctions, last]),
      fc.constantFrom(" ", "  ", "\u00a0"),
      fc.constantFrom("", ".", ":", "!"),
      (words, gap, punctuation) => {
        const text = words.join(gap) + punctuation;
        expect(
          collapseLetterSpacing(text, {
            setApart: true,
            documentWords: documentWordCounts([words.join("")]),
          }),
        ).toBe(text);
        expect(
          collapseLetterSpacing(`n i e   ${text}`, { setApart: true }),
        ).toBe(`nie ${text}`);
      },
    ),
  );
});

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

test("a wholly spaced phrase retains the unambiguous emphasis context", () => {
  expect(collapseLetterSpacing("a i   v e r d i k t")).toBe("ai verdikt");
});

describe("short spaced words in a text that spaces words", () => {
  test.each([
    // Verbatim from the Supreme Court (5 Tdo 242/2005) and the Supreme
    // Administrative Court (7 As 155/2015).
    [
      "Podle § 265l odst. 1 tr. ř.  s e  Okresnímu soudu ve Svitavách   p ř i k a z u j e , aby věc",
      "Podle § 265l odst. 1 tr. ř. se Okresnímu soudu ve Svitavách přikazuje, aby věc",
    ],
    [
      "Žalovanému   s e   náhrada nákladů řízení o kasační stížnosti   n e p ř i z n á v á .",
      "Žalovanému se náhrada nákladů řízení o kasační stížnosti nepřiznává.",
    ],
    // A file's text layer, which keeps the gaps only roughly (19C/150/2006):
    // `s a` is no row of words, since a preposition takes an object.
    [
      "Žalobcovi   s a náhrada trov konania  n e p r i z n á v a.",
      "Žalobcovi sa náhrada trov konania nepriznáva.",
    ],
    // The same file's spaced word over a line break, read once joined.
    [
      "doručená žalobcovi 7.8.2006    j e    n e p l a t n á.",
      "doručená žalobcovi 7.8.2006 je neplatná.",
    ],
    // Polish emphasis (II UKN 93/00, KIO 1589/18, IV Kz 73/19).
    ["o d d a l i ł kasację.", "oddalił kasację."],
    ["U z a s a d n i e n i e", "Uzasadnienie"],
    ["p o s t a n a w i a", "postanawia"],
  ])("reads %j as %j", (spaced, words) => {
    expect(collapseLetterSpacing(spaced)).toBe(words);
  });

  test.each([
    // Rows of words a sentence writes, beside a spaced word.
    [
      "orzeka   i w   p o z o s t a ł e j części",
      "orzeka   i w pozostałej części",
    ],
    ["rozhodl   a v   z a m í t á", "rozhodl   a v zamítá"],
    // An abbreviation beside one.
    ["v r.   2005   z a m í t á", "v r.   2005 zamítá"],
    // A short run with single gaps on both sides is prose's to keep.
    ["bod b c, a soud   z a m í t á", "bod b c, a soud zamítá"],
  ])("reads only the spaced word of %j", (text, words) => {
    expect(collapseLetterSpacing(text)).toBe(words);
  });
});

describe("uneven chunks no line prints whole", () => {
  // Verbatim lines of IV. ÚS 135/2025, with the words the decision prints.
  const documentWords = documentWordCounts([
    "2. Mestskému  súdu  Bratislava  IV  p ri k azu je   v  konaní  sp.  zn.  B2-8C/7/2022  konať",
    "4. Vo zvyšnej časti ústavnej sťažnosti n evyh ovu je.",
    "pri práve na prejednanie je to tak a k tomu je v konaní je ústavnej sťažnosti",
  ]);

  test.each([
    [
      "2. Mestskému  súdu  Bratislava  IV  p ri k azu je   v  konaní",
      "2. Mestskému  súdu  Bratislava  IV  prikazuje   v  konaní",
    ],
    [
      "4. Vo zvyšnej časti ústavnej sťažnosti n evyh ovu je.",
      "4. Vo zvyšnej časti ústavnej sťažnosti nevyhovuje.",
    ],
  ])("reads %j as %j", (text, words) => {
    expect(collapseLetterSpacing(text, { documentWords })).toBe(words);
  });

  test.each([
    // No fragment: ordinary words the document prints once.
    "Vo zvyšnej časti nie je to.",
    // Two pieces only.
    "3 x denne.",
    // Not ended by a gap or a mark.
    "n evyh ovu je v konaní sp. zn.",
    // A long piece is ordinary prose, however rare.
    "p rozhodnutie k súd je.",
    // The word started before the pieces: `poru` is printed nowhere else.
    "poru šen é boli.",
  ])("leaves %j as it is", (text) => {
    expect(collapseLetterSpacing(text, { documentWords })).toBe(text);
  });
});

describe("collapseLetterSpacing (properties)", () => {
  const isRow = (word: string): boolean =>
    word
      .toLowerCase()
      .split("")
      .every(
        (letter, index, letters) =>
          "aikosuvwz".includes(letter) &&
          (index === letters.length - 1 || "ai".includes(letter)),
      );
  const proseWord = fc.stringMatching(/^[a-záčďéěíňóřšťúůýž]{2,9}$/u);
  const row = fc.constantFrom("a", "i", "a v", "i o", "a k", "i z", "a w");
  const gap = fc.constantFrom(" ", "  ", "   ");
  // Prose: words, each perhaps after a row of one-letter words, as a
  // sentence writes them (a preposition stands before a word).
  const prose = fc
    .array(fc.tuple(fc.option(row, { nil: undefined }), proseWord), {
      minLength: 1,
      maxLength: 6,
    })
    .map((parts) =>
      parts.flatMap(([lead, word]) =>
        lead === undefined ? [word] : [lead, word],
      ),
    );

  test("prose without spaced words is left byte for byte", () => {
    assertProperty(
      "prose without spaced words is left byte for byte",
      fc.property(
        prose,
        fc.array(gap, { minLength: 12, maxLength: 12 }),
        (words, gaps) => {
          const text = words
            .map((word, index) => `${word}${gaps[index % gaps.length] ?? " "}`)
            .join("");
          expect(collapseLetterSpacing(text)).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a spaced word in prose reads as the word, and nothing else changes", () => {
    assertProperty(
      "a spaced word in prose reads as the word, and nothing else changes",
      fc.property(
        prose,
        fc.array(czechWord, { minLength: 1, maxLength: 3 }),
        fc.option(prose, { nil: [] }),
        (before, emphasis, after) => {
          fc.pre(emphasis.some((word) => word.length >= 4));
          // A short word spelling a row a sentence writes (`a i`) stays apart.
          fc.pre(!emphasis.some((word) => word.length < 4 && isRow(word)));
          const text = [before.join(" "), spaceOut(emphasis), after.join(" ")]
            .filter((part) => part !== "")
            .join("   ");
          const words = [before.join(" "), emphasis.join(" "), after.join(" ")]
            .filter((part) => part !== "")
            .join(" ");
          expect(collapseLetterSpacing(text)).toBe(words);
        },
      ),
      { numRuns: 300 },
    );
  });
});

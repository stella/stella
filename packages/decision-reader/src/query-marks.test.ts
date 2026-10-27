import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import {
  foldMarkText,
  MIN_HIGHLIGHT_TOKEN_LENGTH,
  queryHighlightTokens,
  queryMarkRanges,
  wordPrefixMatchEnd,
  wordSpans,
} from "./query-marks";

describe("the words of a query worth marking", () => {
  test("drops words shorter than the floor, which match too much to mean anything", () => {
    expect([...queryHighlightTokens("za to je odpovědnost")]).toEqual([
      "odpovednost",
    ]);
    expect(MIN_HIGHLIGHT_TOKEN_LENGTH).toBe(3);
  });

  test("treats punctuation as a separator, so a refinement's quotes are not part of a token", () => {
    expect([...queryHighlightTokens('náhrada "dobré mravy"')]).toEqual([
      "nahrada",
      "dobre",
      "mravy",
    ]);
  });

  test("reports each word once, however it is cased or accented", () => {
    expect([...queryHighlightTokens("škoda Škoda ŠKODA skoda")]).toEqual([
      "skoda",
    ]);
  });

  test("has nothing to mark for a query that is not there", () => {
    expect([...queryHighlightTokens(undefined)]).toEqual([]);
    expect([...queryHighlightTokens("  ")]).toEqual([]);
  });
});

describe("where a token may match", () => {
  const tokens = queryHighlightTokens("odpovednost pra");

  test("a match runs to the end of the word it started", () => {
    const text = "rozsah odpovednosti za";

    expect(wordPrefixMatchEnd(text, 7, tokens)).toBe(19);
    expect(text.slice(7, 19)).toBe("odpovednosti");
  });

  test("the middle of an unrelated word is not a match", () => {
    // "pra" occurs inside "doprava"; only the word that starts with it may be
    // marked, or a short token lights up the page.
    expect("doprava").toContain("pra");
    expect(wordPrefixMatchEnd("doprava", 3, tokens)).toBeNull();
    expect(wordPrefixMatchEnd("doprava a pravidlo", 10, tokens)).toBe(18);
  });

  test("a word the query did not ask for is not a match", () => {
    expect(wordPrefixMatchEnd("najemni smlouva", 0, tokens)).toBeNull();
  });

  // A letter outside the basic plane is written as two UTF-16 units, and
  // neither half is a letter on its own. A reader that walks units sees a word
  // boundary inside such a letter, and then matches a token in the middle of
  // the word that letter begins.
  test("half of an astral letter is not a word boundary", () => {
    const word = "\u{10348}abc";
    expect(word).toHaveLength(5);

    expect(wordPrefixMatchEnd(word, 2, queryHighlightTokens("abc"))).toBeNull();
  });

  test("a token that starts with an astral letter matches its whole word", () => {
    const text = "\u{10348}abc def";

    expect(
      wordPrefixMatchEnd(text, 0, queryHighlightTokens("\u{10348}abc")),
    ).toBe(5);
    expect(text.slice(0, 5)).toBe("\u{10348}abc");
  });
});

/**
 * What a reader types against what a decision says, one row per language the
 * reader's corpus is published in plus the Turkish dotted and dotless i. Each
 * shown word folds to a different length or shape than it is written in, so a
 * mark drawn at a folded offset would cut the word wrongly.
 */
const LANGUAGE_CASES = [
  { language: "cs", shown: "Dvořák", typed: "dvorak" },
  { language: "cs", shown: "Náhrada", typed: "nahrada" },
  { language: "de", shown: "Straße", typed: "strasse" },
  { language: "de", shown: "Müller", typed: "muller" },
  { language: "fr", shown: "Élise", typed: "elise" },
  { language: "fr", shown: "œuvre", typed: "oeuvre" },
  { language: "fr", shown: "ﬁnal", typed: "final" },
  { language: "ar", shown: "مُحَمَّد", typed: "محمد" },
  { language: "ar", shown: "أحمد", typed: "احمد" },
  { language: "tr", shown: "İstanbul", typed: "istanbul" },
  { language: "tr", shown: "ISTANBUL", typed: "ıstanbul" },
] as const;

describe("marks in the original text", () => {
  for (const { language, shown, typed } of LANGUAGE_CASES) {
    test(`${language}: "${typed}" marks "${shown}" whole, and back`, () => {
      // The fixture must fold to something other than itself, or the offset
      // mapping it proves is never exercised.
      expect(foldSearchMatchText(shown)).not.toBe(shown);
      const text = `(${shown}), viz ${shown}.`;
      const marks = queryMarkRanges(text, queryHighlightTokens(typed));

      expect(marks.map(({ end, start }) => text.slice(start, end))).toEqual([
        shown,
        shown,
      ]);
      expect(queryMarkRanges(typed, queryHighlightTokens(shown))).toEqual([
        { start: 0, end: typed.length },
      ]);
    });
  }

  test("a character that folds around a separator stays one word", () => {
    // "½" folds to "1⁄2"; were the fraction slash a separator, the one
    // character would carry two words and draw two overlapping marks.
    expect(foldMarkText("½").text).toBe("12");
    expect(queryMarkRanges("½0 let", queryHighlightTokens("120"))).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  test("spaced-out emphasis is one word", () => {
    const text = "Soud r o z h o d o l takto";

    expect(
      queryMarkRanges(text, queryHighlightTokens("rozhodol")).map(
        ({ end, start }) => text.slice(start, end),
      ),
    ).toEqual(["r o z h o d o l"]);
  });
});

/**
 * Characters whose fold changes length or shape (expansions, ligatures,
 * combining marks, contextual case, presentation forms, a character that
 * folds to two numbers around a separator), astral letters, lone surrogates
 * and separators.
 */
const FOLD_CHARACTERS = [
  ...Array.from("aAzZ09 .,-§\t"),
  ...Array.from("ßẞæÆœŒﬁﬂĳłŁøØđıİ"),
  ...Array.from("ÁáčČěŘšůžÉéèçÖöÜü"),
  ...Array.from("ΣσςΛΌ"),
  ...Array.from("ﺍﺣﻤﺪأإآةهـًٌَ٢"),
  "½",
  "⑴",
  "é",
  "Å",
  "\u{10348}",
  "😀",
  "\ud800",
  "\udc00",
];

const foldText = fc
  .array(fc.constantFrom(...FOLD_CHARACTERS), { maxLength: 24 })
  .map((parts) => parts.join(""));

/** Not between the two units of one astral character. */
const isCodePointBoundary = (text: string, index: number): boolean =>
  index <= 0 || (text.codePointAt(index - 1) ?? 0) <= 0xff_ff;

describe("the folded text's map back to the original", () => {
  test("folded words map to disjoint, ordered ranges on character boundaries", () => {
    assertProperty(
      "folded words map to disjoint, ordered ranges on character boundaries",
      fc.property(foldText, (text) => {
        const folded = foldMarkText(text);
        expect(folded.startMap).toHaveLength(folded.text.length);
        expect(folded.endMap).toHaveLength(folded.text.length);
        let previousEnd = 0;
        for (const span of wordSpans(folded.text)) {
          const start = folded.startMap.at(span.start) ?? -1;
          const end = folded.endMap.at(span.end - 1) ?? -1;
          expect(start).toBeGreaterThanOrEqual(previousEnd);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(text.length);
          expect(isCodePointBoundary(text, start)).toBe(true);
          expect(isCodePointBoundary(text, end)).toBe(true);
          previousEnd = end;
        }
      }),
    );
  });

  /**
   * Folding the original run a word maps back to gives that word again: the
   * map points at exactly the characters the word was folded from, however
   * much longer or shorter their fold is.
   */
  test("the run a folded word maps to folds back to that word", () => {
    assertProperty(
      "the run a folded word maps to folds back to that word",
      fc.property(foldText, (text) => {
        const folded = foldMarkText(text);
        for (const span of wordSpans(folded.text)) {
          const start = folded.startMap.at(span.start) ?? -1;
          const end = folded.endMap.at(span.end - 1) ?? -1;
          expect(foldMarkText(text.slice(start, end)).text).toBe(
            folded.text.slice(span.start, span.end),
          );
        }
      }),
    );
  });

  /**
   * The words are the shared search key's letters and digits, nothing added
   * or lost: what a list filter matches on, the reader marks on.
   */
  test("the folded words are the shared search key's letters and digits", () => {
    assertProperty(
      "the folded words are the shared search key's letters and digits",
      fc.property(foldText, (text) => {
        expect(foldMarkText(text).text.replaceAll(" ", "")).toBe(
          foldSearchMatchText(text).replaceAll(/[^\p{L}\p{N}]/gu, ""),
        );
      }),
    );
  });

  test("every word of a text is marked when the query is that text", () => {
    assertProperty(
      "every word of a text is marked when the query is that text",
      fc.property(foldText, (text) => {
        const folded = foldMarkText(text);
        const longWords = wordSpans(folded.text).filter(
          ({ end, start }) => end - start >= MIN_HIGHLIGHT_TOKEN_LENGTH,
        );
        const marked = queryMarkRanges(text, queryHighlightTokens(text));
        expect(marked).toHaveLength(longWords.length);
      }),
    );
  });
});

import { describe, expect, test } from "bun:test";

import {
  MIN_HIGHLIGHT_TOKEN_LENGTH,
  queryHighlightTokens,
  SEARCH_MARK_CLASS_NAME,
  SEARCH_MARK_DESCENDANT_CLASS_NAME,
  wordPrefixMatchEnd,
} from "@/components/legal-reader/query-marks";

describe("the words of a query worth marking", () => {
  test("drops words shorter than the floor, which match too much to mean anything", () => {
    expect(queryHighlightTokens("za to je odpovědnost")).toEqual([
      "odpovědnost",
    ]);
    expect(MIN_HIGHLIGHT_TOKEN_LENGTH).toBe(3);
  });

  test("treats punctuation as a separator, so a refinement's quotes are not part of a token", () => {
    expect(queryHighlightTokens('náhrada "dobré mravy"')).toEqual([
      "náhrada",
      "dobré",
      "mravy",
    ]);
  });

  test("reports each word once", () => {
    expect(queryHighlightTokens("škoda Škoda ŠKODA")).toEqual(["škoda"]);
  });

  test("has nothing to mark for a query that is not there", () => {
    expect(queryHighlightTokens(undefined)).toEqual([]);
    expect(queryHighlightTokens("  ")).toEqual([]);
  });
});

describe("where a token may match", () => {
  const tokens = ["odpovednost", "pra"];

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

    expect(wordPrefixMatchEnd(word, 2, ["abc"])).toBeNull();
  });

  test("a token that starts with an astral letter matches its whole word", () => {
    const text = "\u{10348}abc def";

    expect(wordPrefixMatchEnd(text, 0, ["\u{10348}abc"])).toBe(5);
    expect(text.slice(0, 5)).toBe("\u{10348}abc");
  });
});

describe("the mark a query's words wear", () => {
  // Both spellings have to exist because Tailwind emits only the classes it
  // can read in the source, so a generated name produces no CSS. That makes
  // them two copies of one decision, and a test is what keeps them one.
  test("the descendant form says exactly what the plain form says", () => {
    const asDescendant = (utility: string): string =>
      utility.startsWith("dark:")
        ? `dark:[&_mark]:${utility.slice("dark:".length)}`
        : `[&_mark]:${utility}`;

    expect(new Set(SEARCH_MARK_DESCENDANT_CLASS_NAME.split(" "))).toEqual(
      new Set(SEARCH_MARK_CLASS_NAME.split(" ").map(asDescendant)),
    );
  });
});

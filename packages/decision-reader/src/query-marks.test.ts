import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  MIN_HIGHLIGHT_TOKEN_LENGTH,
  queryHighlightTokens,
  createWordPrefixMatcher,
} from "./query-marks";

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

    expect(createWordPrefixMatcher(tokens)(text, 7)).toBe(19);
    expect(text.slice(7, 19)).toBe("odpovednosti");
  });

  test("the middle of an unrelated word is not a match", () => {
    // "pra" occurs inside "doprava"; only the word that starts with it may be
    // marked, or a short token lights up the page.
    expect("doprava").toContain("pra");
    expect(createWordPrefixMatcher(tokens)("doprava", 3)).toBeNull();
    expect(createWordPrefixMatcher(tokens)("doprava a pravidlo", 10)).toBe(18);
  });

  test("a word the query did not ask for is not a match", () => {
    expect(createWordPrefixMatcher(tokens)("najemni smlouva", 0)).toBeNull();
  });

  // A letter outside the basic plane is written as two UTF-16 units, and
  // neither half is a letter on its own. A reader that walks units sees a word
  // boundary inside such a letter, and then matches a token in the middle of
  // the word that letter begins.
  test("half of an astral letter is not a word boundary", () => {
    const word = "\u{10348}abc";
    expect(word).toHaveLength(5);

    expect(createWordPrefixMatcher(["abc"])(word, 2)).toBeNull();
  });

  test("a token that starts with an astral letter matches its whole word", () => {
    const text = "\u{10348}abc def";

    expect(createWordPrefixMatcher(["\u{10348}abc"])(text, 0)).toBe(5);
    expect(text.slice(0, 5)).toBe("\u{10348}abc");
  });
});

test("word prefixes preserve Czech accents, punctuation, overlapping tokens and empty lists", () => {
  const text = "Novákovi, novak; novák";
  expect(createWordPrefixMatcher(["nov", "novák"])(text.toLowerCase(), 0)).toBe(
    8,
  );
  expect(createWordPrefixMatcher(["novák"])(text.toLowerCase(), 10)).toBeNull();
  expect(createWordPrefixMatcher(["novák"])(text.toLowerCase(), 17)).toBe(22);
  expect(createWordPrefixMatcher([])("novák", 0)).toBeNull();
  expect(createWordPrefixMatcher(["a.b"])("a.b", 0)).toBe(1);
});

test("query prefixes agree with the literal word oracle", () => {
  const fragments = fc
    .array(
      fc.constantFrom(
        "novák",
        "novak",
        "novákovi",
        "𐍈abc",
        "abc",
        " ",
        ".",
        "_",
        "😀",
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join(""));
  assertProperty(
    "query prefixes agree with the literal word oracle",
    fc.property(
      fragments,
      fc.array(fc.constantFrom("nov", "novák", "abc", "𐍈abc", "a.b"), {
        maxLength: 5,
      }),
      (text, tokens) => {
        const matchPrefix = createWordPrefixMatcher(tokens);
        for (let index = 0; index < text.length; index++) {
          const previous = Array.from(text.slice(0, index)).at(-1);
          const boundary =
            previous === undefined || !/[\p{L}\p{N}_]/u.test(previous);
          let expected: number | null = null;
          if (
            boundary &&
            tokens.some((token) => text.startsWith(token, index))
          ) {
            expected = index;
            for (const character of text.slice(index)) {
              if (!/[\p{L}\p{N}_]/u.test(character)) {
                break;
              }
              expected += character.length;
            }
          }
          expect(matchPrefix(text, index)).toBe(expected);
        }
      },
    ),
  );
});

test("query prefixes normalize unpaired UTF-16 token units", () => {
  // Lone surrogates become replacement characters on both sides of scalar matching.
  const text = "\ud801abc";
  const tokens = ["\ud800"];
  expect(text.startsWith("\ud800")).toBe(false);
  expect(createWordPrefixMatcher(tokens)(text, 0)).toBe(0);
});

test("empty query tokens never mark text or reach the matcher", () => {
  expect(queryHighlightTokens(" \ud800 . ")).toEqual([]);
  expect(createWordPrefixMatcher([""])("𐍈abc", 0)).toBeNull();
  expect(createWordPrefixMatcher(["", "𐍈abc"])("𐍈abc", 0)).toBe(5);
  expect(createWordPrefixMatcher(["", "abc"])("abc", 0)).toBe(3);
});

test("changed token configurations replace cached matches", () => {
  const tokens = ["abc"];
  const initialMatcher = createWordPrefixMatcher(tokens);
  expect(initialMatcher("abc", 0)).toBe(3);
  tokens[0] = "xyz";
  expect(initialMatcher("abc", 0)).toBe(3);
  expect(createWordPrefixMatcher(tokens)("abc", 0)).toBeNull();
});

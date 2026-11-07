import { describe, expect, test } from "bun:test";

import { collapseSpacedLetters, letterSpacingJoins } from "./letter-spacing.js";

// Real letter-spaced court headings collapse; short single-letter word
// lists (Czech/Slovak prepositions) must stay untouched.
const GOLDEN: readonly (readonly [string, string])[] = [
  ["r o z h o d o l :", "rozhodol:"],
  ["z a m i e t a", "zamieta"],
  ["o d ô v o d n e n i e :", "odôvodnenie:"],
  ["súd r o z h o d o l : takto", "súd rozhodol: takto"],
  // Threshold floor: fewer than four spaced letters is left verbatim.
  ["a b", "a b"],
  ["a b c", "a b c"],
  ["u a v", "u a v"],
  // Four is the first run that collapses.
  ["a b c d", "abcd"],
  // Normal prose is never touched.
  ["hello world", "hello world"],
];

describe("collapseSpacedLetters", () => {
  test.each(GOLDEN)("collapse(%p) === %p", (input, expected) => {
    expect(collapseSpacedLetters(input)).toBe(expected);
  });

  test("collapses only runs of four or more spaced letters", () => {
    // Exhaustive check of the threshold: build an n-letter spaced run and
    // confirm it collapses iff n >= 4.
    const letters = "abcdefgh";
    for (let n = 1; n <= letters.length; n++) {
      const run = letters.slice(0, n).split("").join(" ");
      const collapsed = collapseSpacedLetters(run);
      if (n >= 4) {
        expect(collapsed).toBe(letters.slice(0, n));
      } else {
        expect(collapsed).toBe(run);
      }
    }
  });

  test("is idempotent", () => {
    for (const [input] of GOLDEN) {
      const once = collapseSpacedLetters(input);
      expect(collapseSpacedLetters(once)).toBe(once);
    }
  });
});

describe("letterSpacingJoins", () => {
  test("names the gaps the fold removes, and only those", () => {
    const text = "súd r o z h o d o l : a b c dnes";
    const joins = letterSpacingJoins(text);
    // The spaced word's gaps, its spaced colon's included; the gaps of
    // "a b c" and every word gap stay.
    expect(joins).toEqual([5, 7, 9, 11, 13, 15, 17, 19]);
    const drawn = text
      .split("")
      .filter((_, index) => !joins.includes(index))
      .join("");
    expect(drawn).toBe(collapseSpacedLetters(text));
  });

  test("names nothing in text without spaced letters", () => {
    expect(letterSpacingJoins("hello   world")).toEqual([]);
  });
});

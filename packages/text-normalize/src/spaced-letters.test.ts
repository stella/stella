import { describe, expect, test } from "bun:test";

import {
  collapseSpacedLetters,
  spacedLetterRunRegex,
} from "./spaced-letters.js";

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

describe("spacedLetterRunRegex", () => {
  test("returns a fresh global regex each call", () => {
    const a = spacedLetterRunRegex();
    const b = spacedLetterRunRegex();
    expect(a).not.toBe(b);
    expect(a.global).toBe(true);
  });

  test("matches the same runs collapseSpacedLetters removes", () => {
    const text = "súd r o z h o d o l : a b c dnes";
    const matches = [...text.matchAll(spacedLetterRunRegex())].map((m) => m[0]);
    // Only the four-plus run matches; the "a b c" list does not.
    expect(matches).toEqual(["r o z h o d o l :"]);
  });
});

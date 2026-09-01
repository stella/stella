/**
 * Properties of `collapseSpacedLetters` over its whole input class.
 *
 * The golden vectors in `spaced-letters.test.ts` pin the cases someone
 * thought of. These pin the invariants instead, generated over letters ×
 * gap encodings × sentence shapes, because the defect this function
 * exists to survive was a *gap encoding* nobody had a vector for: an
 * Aspose spacer span whose whitespace the parser dropped, which the
 * committed fixtures then supplied back as pretty-printer newlines.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { collapseSpacedLetters } from "./spaced-letters.js";

// Fixed seed: a normalization guard that explores different inputs on
// every CI run reports failures nobody can reproduce from the log alone.
// The nightly sweep widens coverage by scaling numRuns, not by reseeding.
const SEED = 20_260_901;

const config = (numRuns: number) => propertyConfig({ numRuns, seed: SEED });

// Czech and Slovak letters, the orthographies this function was written
// for. Diacritics are included deliberately: they are multi-codepoint
// under NFD and the run regex matches `\p{L}`, so a caron carries real
// risk of splitting a letter the collapse should have kept whole.
const ALPHABET = "abcdefghijklmnoprstuvyzáčďéěíňóřšťúůýž".split("");

const letter = fc.constantFrom(...ALPHABET);

/**
 * A word long enough to be collapsed.
 *
 * The function deliberately ignores runs shorter than four letters:
 * Czech and Slovak spell many one-letter prepositions, so `u a v` is far
 * more likely to be three words than one letter-spaced one. Round-trip
 * properties therefore only hold above that floor, and generating below
 * it would assert the opposite of the documented contract.
 */
const collapsibleWord = fc
  .array(letter, { minLength: 4, maxLength: 12 })
  .map((letters) => letters.join(""));

const sentence = fc
  .array(collapsibleWord, { minLength: 1, maxLength: 6 })
  .map((words) => words.join(" "));

/**
 * Whitespace a publisher puts between two letter-spaced words.
 *
 * Built from its code point rather than written literally: a no-break
 * space is indistinguishable from an ordinary one in source, and the
 * difference between the two is the entire subject of these tests.
 */
const NBSP = "\u00a0";

const WORD_GAPS = {
  "two spaces": "  ",
  "three spaces": "   ",
  "no-break space": NBSP,
  "two no-break spaces": `${NBSP}${NBSP}`,
} as const;

/** Render a sentence the way a publisher letter-spaces it for emphasis. */
const letterSpace = (text: string, gap: string): string =>
  text
    .split(" ")
    .map((word) => word.split("").join(" "))
    .join(gap);

/** Everything that is not an ASCII space, in order. */
const nonSpace = (text: string): string => text.replaceAll(" ", "");

/** The whitespace-separated words of a line, in order. */
const words = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word.length > 0);

/** Characters a court line mixes with letters, gap encodings included. */
const noiseCharacter = fc.constantFrom(" ", "  ", "   ", NBSP, ":", ".", ",");

const noisyLine = fc
  .array(fc.oneof(letter, noiseCharacter), { maxLength: 40 })
  .map((parts) => parts.join(""));

describe("collapseSpacedLetters (properties)", () => {
  /**
   * Round trip: letter-space a sentence, collapse it, get the sentence
   * back. This is the property that would have caught the cz-nss defect
   * at the string layer — the parser bug reached this function as a run
   * whose word gap had gone missing.
   *
   * Compared as a word sequence, not as a string: the function squeezes
   * runs of ASCII spaces but deliberately leaves no-break spaces alone,
   * so a two-no-break-space gap legitimately stays two characters wide.
   * The width of a gap is not the contract; where the gaps fall is, and
   * that is exactly what the cz-nss defect got wrong when it re-cut
   * `Žaloba se zamítá` into `Žalob as ez amítá`.
   */
  for (const [gapName, gap] of Object.entries(WORD_GAPS)) {
    test(`round-trips a letter-spaced sentence with ${gapName} gaps`, () => {
      fc.assert(
        fc.property(sentence, (original) => {
          const collapsed = collapseSpacedLetters(letterSpace(original, gap));

          expect(words(collapsed)).toEqual(words(original));
        }),
        config(300),
      );
    });
  }

  /**
   * The function may delete and merge ASCII spaces. It may never touch
   * anything else — no letter reordered, dropped or introduced. This is
   * the invariant that makes the collapse safe to run over court text
   * the reader must reproduce verbatim.
   */
  test("changes only ASCII spaces", () => {
    fc.assert(
      fc.property(noisyLine, (input) => {
        expect(nonSpace(collapseSpacedLetters(input))).toBe(nonSpace(input));
      }),
      config(500),
    );
  });

  /** Only spaces are ever removed, so the result can never grow. */
  test("never grows the text", () => {
    fc.assert(
      fc.property(noisyLine, (input) => {
        expect(collapseSpacedLetters(input).length).toBeLessThanOrEqual(
          input.length,
        );
      }),
      config(500),
    );
  });

  /**
   * Regression for the defect this file was written to catch: the
   * function collapsed more on its second application than on its first,
   * so index-time and query-time normalization of the same text
   * disagreed. Fixed by applying the collapse to a fixpoint.
   */
  test("is idempotent", () => {
    fc.assert(
      fc.property(noisyLine, (input) => {
        const once = collapseSpacedLetters(input);

        expect(collapseSpacedLetters(once)).toBe(once);
      }),
      config(500),
    );
  });

  /**
   * The same guarantee stated from the other side: text already in normal
   * form is returned untouched. This is what lets a caller normalize
   * defensively without risking a second, different collapse.
   */
  test("is the identity on text already in normal form", () => {
    fc.assert(
      fc.property(noisyLine, (input) => {
        const normalized = collapseSpacedLetters(input);

        expect(collapseSpacedLetters(normalized)).toBe(normalized);
      }),
      config(500),
    );
  });

  /**
   * The specific input that used to need two calls.
   */
  test("collapses a run written with two spaces in one call", () => {
    expect(collapseSpacedLetters("a  b  c  d")).toBe("abcd");
  });

  /**
   * Guard against the tempting wrong fix. Widening the pattern's letter
   * separator to `+` also makes one pass settle, and merges the whole
   * verdict into one word: a single space separates the letters of an
   * emphasized word, a wider gap separates two of them. If this ever
   * reads "Žalobasezamítá", that distinction has been lost.
   *
   * "s e" stays spaced because of the documented four-letter floor —
   * Czech and Slovak spell too many one-letter words to join a shorter
   * run safely.
   */
  test("keeps letter-spaced words apart when the word gap is wider", () => {
    expect(collapseSpacedLetters("Ž a l o b a  s e  z a m í t á")).toBe(
      "Žaloba s e zamítá",
    );
    expect(collapseSpacedLetters("Ž a l o b a  z a m í t á")).toBe(
      "Žaloba zamítá",
    );
  });
});

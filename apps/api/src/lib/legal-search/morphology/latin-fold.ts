/**
 * The fold the index applies to a stem, letter by letter, for the query side
 * to compute the same key: `@stll/text-normalize`'s ASCII fold (which keeps
 * parity with the engine's `ascii_folding`) over Latin letters, and nothing
 * else. Other scripts are outside that contract, so their letters are kept
 * rather than guessed at.
 */

import { foldToAscii } from "@stll/text-normalize";

const LATIN_LETTER = /^\p{Script=Latin}$/u;

const ASCII_LETTERS = /^[a-z]+$/u;

const foldedLetters = new Map<string, string>();

/**
 * One character as the index folds it: a Latin letter to its ASCII letters,
 * anything else unchanged. Assumes lowercase input, as every stemmer does.
 */
export const foldLatinLetter = (letter: string): string => {
  if (letter < "\u0080") {
    return letter;
  }
  const known = foldedLetters.get(letter);
  if (known !== undefined) {
    return known;
  }
  const folded = foldToAscii(letter);
  const result =
    LATIN_LETTER.test(letter) && ASCII_LETTERS.test(folded) ? folded : letter;
  foldedLetters.set(letter, result);
  return result;
};

/**
 * A lowercase term with its Latin letters folded the way the index folds
 * them, other scripts untouched.
 */
export const foldLatinLetters = (term: string): string => {
  let folded = "";
  for (const letter of term) {
    folded += foldLatinLetter(letter);
  }
  return folded;
};

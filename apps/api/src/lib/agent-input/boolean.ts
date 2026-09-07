/**
 * Yes/no answers on the agent wire.
 *
 * A model asked for a boolean answers in the language of the document it is
 * drafting as often as in JSON, so the words below are the ones that occur in
 * the workspace's languages plus the checkbox vocabulary. The set is closed:
 * anything outside it asks rather than falling back to JavaScript truthiness,
 * where `"false"` and `"ne"` are both true.
 */

import { foldToAscii } from "@stll/text-normalize";

import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export const BOOLEAN_EXPECTED = "a yes/no answer";
export const BOOLEAN_HINT =
  "Send true or false as a JSON boolean; the words yes/no, y/n, 1/0, on/off, " +
  "ano/ne, tak/nie, ja/nein and checked/unchecked are read as well.";

const TRUE_WORDS = [
  "true",
  "yes",
  "y",
  "1",
  "on",
  "ano",
  "tak",
  "ja",
  "checked",
] as const;

const FALSE_WORDS = [
  "false",
  "no",
  "n",
  "0",
  "off",
  "ne",
  "nie",
  "nein",
  "unchecked",
] as const;

const WORDS: ReadonlyMap<string, boolean> = new Map([
  ...TRUE_WORDS.map((word) => [word, true] as const),
  ...FALSE_WORDS.map((word) => [word, false] as const),
]);

/** Read a yes/no answer an agent spelled its own way. */
export const normalizeBoolean = (input: unknown): Normalized<boolean> => {
  if (typeof input === "boolean") {
    return readValueAs(input, input);
  }
  if (typeof input === "number") {
    if (input === 1 || input === 0) {
      return readValueAs(input, input === 1);
    }
    return askForFix({
      input,
      expected: BOOLEAN_EXPECTED,
      hint: BOOLEAN_HINT,
    });
  }
  if (typeof input !== "string") {
    return askForFix({ input, expected: BOOLEAN_EXPECTED, hint: BOOLEAN_HINT });
  }
  const word = WORDS.get(foldToAscii(input.trim()).toLowerCase());
  if (word === undefined) {
    return askForFix({ input, expected: BOOLEAN_EXPECTED, hint: BOOLEAN_HINT });
  }
  return readValueAs(input, word);
};

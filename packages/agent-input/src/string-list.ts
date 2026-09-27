/**
 * Lists of strings on the agent wire.
 *
 * A model asked for an array often sends the array's JSON as a string
 * (`"[\"a\", \"b\"]"`), or one bare string where the schema wanted a list of
 * one. Both carry one meaning and are read. A comma-separated string carries
 * one meaning only where an item cannot itself hold a comma: a list of court
 * ids can be split, a list of search phrases cannot (`"Smith, J."` is one
 * phrase), so the caller says which by `split`.
 */

import { Result } from "better-result";

import type { Normalized } from "./normalized";
import { askForFix, readValue, readValueAs } from "./normalized";

export type StringListOptions = {
  /** `"delimiters"` splits a scalar on commas, semicolons and newlines, for
   *  items that cannot contain them (ids, codes). `"never"` wraps a scalar as
   *  one item, for free text that may. */
  split: "never" | "delimiters";
};

const STRING_LIST_EXPECTED = "a list of strings";
const STRING_LIST_HINT = 'Send a JSON array of strings, for example ["a", "b"]';

const DELIMITERS_RE = /[,;\r\n]/u;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The array a string spells as JSON, or null when it spells something else. */
const parseJsonArray = (trimmed: string): string[] | null => {
  if (!trimmed.startsWith("[")) {
    return null;
  }
  const parsed = Result.try((): unknown => JSON.parse(trimmed));
  return parsed.isOk() && isStringArray(parsed.value) ? parsed.value : null;
};

/** Read a list of strings an agent spelled its own way. Only the list's own
 *  shape is read here: an array is taken as it is, and one holding anything
 *  but strings asks, since what an item should have been is the item's
 *  question, not the list's. */
export const normalizeStringList = (
  input: unknown,
  options: StringListOptions,
): Normalized<string[]> => {
  if (isStringArray(input)) {
    return readValue(input);
  }
  if (typeof input !== "string") {
    return askForFix({
      input,
      expected: STRING_LIST_EXPECTED,
      hint: STRING_LIST_HINT,
    });
  }

  const parsed = parseJsonArray(input.trim());
  if (parsed !== null) {
    return readValueAs(input, parsed);
  }
  if (options.split === "never") {
    return readValueAs(input, [input]);
  }
  const pieces = input
    .split(DELIMITERS_RE)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
  return readValueAs(input, pieces);
};

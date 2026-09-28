/**
 * Placeholders on optional filters.
 *
 * A model fills every slot a schema shows it, so a filter it means to leave
 * unset still arrives as `"any"`, `"-"` or `"none"`. Those words name no
 * court, no type, no record: read as a value they match nothing and the call
 * returns an empty page the model then explains away. The set is closed and
 * short on purpose; a word outside it is a value and goes to the kind's own
 * reader.
 *
 * This is not for free text. `"none"` is a fine answer to a question and `"-"`
 * a fine clause body, so the caller decides which inputs a placeholder can
 * stand in for.
 */

import { foldToAscii } from "@stll/text-normalize";

/** The words, already in the folded lowercase form they are compared in. */
export const ABSENT_PLACEHOLDERS = [
  "-",
  "--",
  "–",
  "—",
  "*",
  "all",
  "any",
  "none",
  "null",
  "nil",
  "undefined",
  "n/a",
  "(none)",
  "<none>",
  "(any)",
  "(all)",
] as const;

const PLACEHOLDERS: ReadonlySet<string> = new Set(ABSENT_PLACEHOLDERS);

/** Whether a string stands for "no value" on an optional filter: blank, or one
 *  of the placeholder words in any case and spacing. */
export const isAbsentPlaceholder = (input: unknown): boolean => {
  if (typeof input !== "string") {
    return false;
  }
  const trimmed = input.trim();
  return trimmed === "" || PLACEHOLDERS.has(foldToAscii(trimmed).toLowerCase());
};

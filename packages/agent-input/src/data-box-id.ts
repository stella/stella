import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export const DATA_BOX_ID_PATTERN = /^[A-Za-z0-9]{7}$/u;

/** Data box identifiers are case-sensitive external keys, never record UUIDs. */
export const normalizeDataBoxId = (input: unknown): Normalized<string> => {
  const value = typeof input === "string" ? input.trim() : undefined;
  return value !== undefined && DATA_BOX_ID_PATTERN.test(value)
    ? readValueAs(input, value)
    : askForFix({
        input,
        expected: "a seven-character data box ID",
        hint: "Pass the seven letters and digits of the recipient's data box ID.",
      });
};

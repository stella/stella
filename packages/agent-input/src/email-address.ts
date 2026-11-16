import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export const EMAIL_ADDRESS_PATTERN =
  /^[\w+-]+(?:\.[\w+-]+)*@[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*\.[a-zA-Z]{2,}$/u;

/** Preserve the local part's case: contact addresses are not account identity keys. */
export const normalizeEmailAddress = (input: unknown): Normalized<string> => {
  const value = typeof input === "string" ? input.trim() : undefined;
  return value !== undefined &&
    value.length <= 320 &&
    EMAIL_ADDRESS_PATTERN.test(value)
    ? readValueAs(input, value)
    : askForFix({
        input,
        expected: "an email address",
        hint: "Pass one email address, such as name@example.com, without a display name.",
      });
};

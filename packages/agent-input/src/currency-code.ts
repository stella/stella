import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export const normalizeCurrencyCode = (input: unknown): Normalized<string> => {
  const value =
    typeof input === "string" ? input.trim().toUpperCase() : undefined;
  return value !== undefined && /^[A-Z]{3}$/u.test(value)
    ? readValueAs(input, value)
    : askForFix({
        input,
        expected: "a three-letter currency code",
        hint: "Pass a three-letter currency code, such as EUR or CZK.",
      });
};

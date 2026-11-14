import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

/** Case and internal separators identify a different slug; only outer whitespace is noise. */
export const normalizeSlug = (input: unknown): Normalized<string> => {
  if (typeof input === "string" && /^[a-z0-9-]+$/u.test(input.trim())) {
    return readValueAs(input, input.trim());
  }
  return askForFix({
    input,
    expected: "a lowercase slug",
    hint: "Use lowercase ASCII letters, digits or hyphens, without spaces.",
  });
};

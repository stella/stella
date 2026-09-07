/**
 * Locale tags on the agent wire.
 *
 * `Intl` is the authority on both halves: it refuses a structurally malformed
 * tag (a well-formed but unknown one passes and merely falls back at format
 * time) and it spells the canonical form. Underscores are the ICU/POSIX
 * spelling of the same tag, and case carries no meaning, so `cs_cz` and
 * `cs-CZ` are one locale — but only the canonical spelling may be stored,
 * because `new Intl.DateTimeFormat("cs_CZ")` throws.
 */

import { Result } from "better-result";

import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export const LOCALE_EXPECTED = "a BCP-47 language tag";
export const LOCALE_HINT =
  'Write the tag as language or language-REGION: "cs", "pl", "en-GB", "pt-BR".';

/** The canonical spelling of a well-formed tag, or null. `Intl` throws a
 *  RangeError on a malformed tag rather than reporting it. */
const canonicalize = (candidate: string): string | null => {
  const canonical = Result.try({
    try: () => Intl.getCanonicalLocales(candidate),
    catch: (cause) => cause,
  });
  return canonical.isOk() ? (canonical.value.at(0) ?? null) : null;
};

/**
 * Whether a tag is already the spelling `Intl` accepts. This is the check a
 * stored or advertised locale passes: a value that reaches
 * `Intl.DateTimeFormat` at fill time must not be able to make it throw, so the
 * leniency below stops at the boundary and never reaches persistence.
 */
export const isPlausibleLocale = (value: string): boolean =>
  canonicalize(value) !== null;

/** Read a locale an agent spelled its own way, canonically. */
export const normalizeLocale = (input: unknown): Normalized<string> => {
  if (typeof input !== "string") {
    return askForFix({ input, expected: LOCALE_EXPECTED, hint: LOCALE_HINT });
  }
  const canonical = canonicalize(input.trim().replaceAll("_", "-"));
  if (canonical === null) {
    return askForFix({ input, expected: LOCALE_EXPECTED, hint: LOCALE_HINT });
  }
  return readValueAs(input, canonical);
};

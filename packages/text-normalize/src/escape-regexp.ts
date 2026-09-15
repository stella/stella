/**
 * The one escaper for text that becomes part of a pattern.
 *
 * Every call site builds a regular expression around something a document or
 * a user wrote, so each needed the same escape and each had written it out.
 * Two spellings of this is one spelling too many: the character class is the
 * contract, and a call site that escapes one character fewer matches things
 * its author never meant it to.
 */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

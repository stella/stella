// parser-output-unchanged: adds a name-handling helper no parser or adapter calls.

/**
 * Every format character (`Cf`) except ZWNJ and ZWJ: those two select letter
 * forms in Persian and Indic scripts and join emoji sequences, so removing
 * them changes what a name says, and neither can reorder text.
 */
const INVISIBLE_FORMATTING = /(?![\u200C\u200D])\p{Cf}/gu;

/** Removes the characters a stored name or a download name must not carry. */
export const stripInvisibleFormatting = (text: string): string =>
  text.replaceAll(INVISIBLE_FORMATTING, "");

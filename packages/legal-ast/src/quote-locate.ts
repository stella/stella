/**
 * Find a model's quote inside the block it cited, as offsets into the
 * block's own text.
 *
 * Models copy text faithfully but not byte-for-byte: they straighten curly
 * quotes, turn non-breaking spaces into spaces, and collapse runs of
 * whitespace. Those spellings carry one meaning, so they are matched; any
 * other difference is a misquote and is not.
 */

import { foldQuoteText } from "./quote-fold";

type Span = { start: number; end: number };

const fold = (text: string) => foldQuoteText(text, "collapse");

/**
 * The span of `quote` in `text`, preferring the first occurrence at or after
 * `from` so repeated wording in one block maps to successive claims. Null
 * when the quote is not in the block.
 */
export const locateQuote = (
  text: string,
  quote: string,
  from = 0,
): Span | null => {
  const trimmed = quote.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const haystack = fold(text);
  const needle = fold(trimmed).folded.trim();
  const foldedFrom = haystack.origin.findIndex((index) => index >= from);
  let at = foldedFrom === -1 ? -1 : haystack.folded.indexOf(needle, foldedFrom);
  if (at === -1) {
    at = haystack.folded.indexOf(needle);
  }
  if (at === -1) {
    return null;
  }
  const start = haystack.origin.at(at);
  const last = haystack.origin.at(at + needle.length - 1);
  if (start === undefined || last === undefined) {
    return null;
  }
  return { start, end: last + 1 };
};

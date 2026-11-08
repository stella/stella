/**
 * Characters a reader leaves undrawn, recognised for display.
 *
 * Some publisher typography reads as noise on screen: a letter-spaced
 * heading (`O d ů v o d n ě n í :`), a backslash printed before every
 * quotation mark (`\"smlouva o půjčce\"`). The stored text stays exactly as
 * published; this module only names, per text, the source characters a
 * reader may leave out of what it draws.
 *
 * Nothing here rewrites text. An elision is a range of the source string, so
 * a reader keeps every character in its document (hidden, not removed) and
 * search ranges, annotation offsets and block anchors index the same
 * characters as before by construction. No offset map exists because none is
 * needed: the drawn text is the source minus the elided ranges.
 *
 * Letter spacing follows the one reading the index and the reader's find
 * already share (`letterSpacingJoins` in `@stll/text-normalize`), so the
 * reader draws a spaced word the way search folds it.
 */

import { letterSpacingJoins } from "@stll/text-normalize";

export const DISPLAY_ELISION_KIND = {
  /** A space between the letters of a letter-spaced word. */
  LETTER_SPACING: "letter-spacing",
  /** A backslash a publisher printed before every quotation mark. */
  ESCAPED_QUOTE: "escaped-quote",
} as const;

type DisplayElisionKind =
  (typeof DISPLAY_ELISION_KIND)[keyof typeof DISPLAY_ELISION_KIND];

/** Source characters `[start, end)` a reader leaves undrawn. */
export type DisplayElision = {
  kind: DisplayElisionKind;
  start: number;
  end: number;
};

/** Adjacent elided indices as ranges, in order. */
const elisionRanges = (
  indices: readonly number[],
  kind: DisplayElisionKind,
): DisplayElision[] => {
  const ranges: DisplayElision[] = [];
  for (const index of indices) {
    const last = ranges.at(-1);
    if (last?.end === index) {
      last.end = index + 1;
      continue;
    }
    ranges.push({ kind, start: index, end: index + 1 });
  }
  return ranges;
};

/**
 * The gaps inside every letter-spaced word: exactly the whitespace the
 * owner's fold removes, so the drawn text, its spaces squeezed as a browser
 * draws them, is the fold.
 */
const letterSpacingElisions = (text: string): DisplayElision[] =>
  elisionRanges(letterSpacingJoins(text), DISPLAY_ELISION_KIND.LETTER_SPACING);

const QUOTE = '"';
const BACKSLASH = "\\";

/**
 * The backslash before each quotation mark, where one stands before every
 * quotation mark in the text and none is itself escaped.
 *
 * The Czech Supreme Court's database serves part of its older decisions with
 * `\&quot;` for every quotation mark, in both the detail and the print page:
 * an escape from the publisher's own export that reached the published text.
 * The text is stored as published; the reader leaves the backslash undrawn.
 * A text with any quotation mark standing without a lone backslash before it
 * keeps every backslash, so a backslash the text means is never hidden.
 */
const escapedQuoteElisions = (text: string): DisplayElision[] => {
  const elisions: DisplayElision[] = [];
  for (
    let index = text.indexOf(QUOTE);
    index !== -1;
    index = text.indexOf(QUOTE, index + 1)
  ) {
    if (
      text.charAt(index - 1) !== BACKSLASH ||
      text.charAt(index - 2) === BACKSLASH
    ) {
      return [];
    }
    elisions.push({
      kind: DISPLAY_ELISION_KIND.ESCAPED_QUOTE,
      start: index - 1,
      end: index,
    });
  }
  return elisions;
};

/** Every elision in `text`, ordered by start and non-overlapping. */
export const displayElisions = (text: string): DisplayElision[] =>
  [...letterSpacingElisions(text), ...escapedQuoteElisions(text)].toSorted(
    (left, right) => left.start - right.start,
  );

/** The source with the elided ranges left out: what a reader draws. */
export const drawnText = (
  text: string,
  elisions: readonly DisplayElision[],
): string => {
  let drawn = "";
  let cursor = 0;
  for (const { start, end } of elisions) {
    drawn += text.slice(cursor, start);
    cursor = end;
  }
  return drawn + text.slice(cursor);
};

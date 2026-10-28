import { findPostgresSearchFoldRanges } from "@stll/text-normalize/postgres-search-fold";

/**
 * Splitting rendered text on a find term, without React.
 */
/** A run of the rendered text, with whether the find term produced it. */
export type TextSegment = {
  matched: boolean;
  /** Where the run starts in the input, which is the run's only identity. */
  start: number;
  text: string;
};

/**
 * Split rendered text into matched and unmatched runs, ignoring case and
 * accents exactly as the server's find does.
 *
 * The server matches `search_fold(cell) LIKE '%' || search_fold(term) || '%'`,
 * and `findPostgresSearchFoldRanges` reproduces that fold code point for code
 * point, so `dvorak` marks `Dvořák` and nothing the server would not have
 * matched gets marked. It is not the broader client search fold: marking a
 * run the server did not match on would be a worse lie than leaving a run
 * unmarked. A fold that changes length (`Æ` to `ae`, a deleted combining
 * mark) maps back to whole characters of the input.
 *
 * The concatenated segments always equal the input, so a caller cannot lose or
 * duplicate text by rendering them.
 */
export const splitByMatch = (text: string, term: string): TextSegment[] => {
  if (term === "" || text === "") {
    return text === "" ? [] : [{ matched: false, start: 0, text }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const { start, end } of findPostgresSearchFoldRanges(text, term)) {
    if (start > cursor) {
      segments.push({
        matched: false,
        start: cursor,
        text: text.slice(cursor, start),
      });
    }
    segments.push({
      matched: true,
      start,
      text: text.slice(start, end),
    });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ matched: false, start: cursor, text: text.slice(cursor) });
  }
  return segments;
};

/**
 * Whether the find term produced any run in `text`.
 *
 * Defined through the splitter rather than beside it: a client-side find uses
 * this to decide which rows stay and the same splitter to mark them, so a row
 * survives exactly when a mark is drawn in it.
 */
export const containsMatch = (text: string, term: string): boolean =>
  splitByMatch(text, term).some((segment) => segment.matched);

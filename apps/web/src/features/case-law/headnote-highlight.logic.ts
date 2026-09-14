/**
 * Why a row matched, shown inside the publisher's own summary.
 *
 * The search engine highlights the passage it matched (`headline`), but a
 * decision that carries a headnote shows the headnote instead, and nothing in
 * it says which words the reader asked for. Marking them here closes that: the
 * hook stays the decision's own sentence and still explains itself.
 *
 * The output is segments, never markup. A highlighter that returned an HTML
 * string would put the escaping rule between a corpus text and the DOM, and a
 * headnote is publisher text: the one place an escaping mistake becomes an
 * injection. Segments cannot carry markup at all, because the renderer hands
 * every `text` to React as a child and React escapes it.
 *
 * Which words are marked, and where a token may match, is not decided here:
 * the reader marks the same words inside the decision this row opens, so both
 * read it from `@/components/legal-reader/query-marks`.
 */

import { wordPrefixMatchEnd } from "@/components/legal-reader/query-marks";

/**
 * A run of the original text, and whether the query asked for it. `start` is
 * where the run begins in the text: a segment's identity is its position, and
 * a renderer needs that to key the list by something the data supplies.
 */
export type HighlightSegment = {
  start: number;
  text: string;
  match: boolean;
};

/**
 * The text split into marked and unmarked runs, in order. Slices come out of
 * the original string, so diacritics, casing and every other character survive
 * exactly as the publisher wrote them; only the matching is case-folded.
 *
 * With no tokens the whole text is one unmarked segment, which is what a
 * browse listing and a saved research table want.
 */
export const highlightSegments = (
  text: string,
  tokens: readonly string[],
): readonly HighlightSegment[] => {
  if (tokens.length === 0 || text.length === 0) {
    return text.length === 0 ? [] : [{ start: 0, text, match: false }];
  }

  const lowered = text.toLowerCase();
  // Case folding is not always length-preserving (U+0130 lowercases to two
  // code units), and an index into the folded string then addresses the wrong
  // character of the original. Slicing the original is what preserves the
  // publisher's diacritics, so where the two lengths disagree the text is
  // returned unmarked rather than sliced at a shifted offset.
  if (lowered.length !== text.length) {
    return [{ start: 0, text, match: false }];
  }
  const segments: HighlightSegment[] = [];
  let plainFrom = 0;
  let index = 0;
  while (index < text.length) {
    const end = wordPrefixMatchEnd(lowered, index, tokens);
    if (end === null || end === index) {
      index += 1;
      continue;
    }
    if (index > plainFrom) {
      segments.push({
        start: plainFrom,
        text: text.slice(plainFrom, index),
        match: false,
      });
    }
    segments.push({ start: index, text: text.slice(index, end), match: true });
    plainFrom = end;
    index = end;
  }
  if (plainFrom < text.length) {
    segments.push({
      start: plainFrom,
      text: text.slice(plainFrom),
      match: false,
    });
  }
  return segments;
};

/** Whether any of the query's words is in the text at all. */
export const hasHighlight = (segments: readonly HighlightSegment[]): boolean =>
  segments.some((segment) => segment.match);

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
 */

/**
 * Below this a token matches too much to mean anything: in an inflected
 * language two letters are a preposition or a case ending, and marking every
 * occurrence of one reads as noise rather than as an answer.
 */
export const MIN_HIGHLIGHT_TOKEN_LENGTH = 3;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

const NON_WORD_RUN = /[^\p{L}\p{N}_]+/gu;

/**
 * The character at an index, or nothing past either end. Not `.at()`: a
 * negative index there wraps to the end of the string, which would read the
 * last character of the text as the one before its first and refuse every
 * match at position zero.
 */
const characterAt = (text: string, index: number): string | undefined =>
  index < 0 || index >= text.length ? undefined : text.charAt(index);

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.test(character);

/**
 * The words of a query worth marking, lowercased and without repeats.
 * Punctuation is a separator, so the quotes a refinement writes into `q` never
 * become part of a token.
 */
export const queryHighlightTokens = (
  query: string | undefined,
): readonly string[] => {
  if (query === undefined) {
    return [];
  }
  const tokens: string[] = [];
  for (const word of query.replace(NON_WORD_RUN, " ").split(" ")) {
    const token = word.toLowerCase();
    if (token.length < MIN_HIGHLIGHT_TOKEN_LENGTH || tokens.includes(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
};

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
 * Where a token matches, as an index into the lowercased text: at the start of
 * a word only.
 *
 * A word-start rule is what keeps a three-letter token from lighting up the
 * middle of unrelated words, and letting the match run to the end of the word
 * is what makes it useful in an inflected language: "odpovědnost" marks
 * "odpovědnosti" whole, rather than marking a fragment and leaving a stray
 * ending behind. Prefix, not substring.
 */
const matchEnd = (
  lowered: string,
  index: number,
  tokens: readonly string[],
): number | null => {
  if (isWordCharacter(characterAt(lowered, index - 1))) {
    return null;
  }
  const matched = tokens.some((token) => lowered.startsWith(token, index));
  if (!matched) {
    return null;
  }
  let end = index;
  while (isWordCharacter(characterAt(lowered, end))) {
    end += 1;
  }
  return end;
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
    const end = matchEnd(lowered, index, tokens);
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

/**
 * The words a query marks, and how a mark looks.
 *
 * A search answers on two surfaces: the results table, which marks why a row
 * matched, and the reader, which marks the same words inside the decision the
 * row opens. A reader who clicks a result and finds different words marked —
 * or the same words marked differently — reads that as two searches rather
 * than one. So the tokenisation, the match rule and the mark are one
 * definition here, and neither surface keeps a second.
 */

/**
 * Below this a token matches too much to mean anything: in an inflected
 * language two letters are a preposition or a case ending, and marking every
 * occurrence of one reads as noise rather than as an answer.
 */
export const MIN_HIGHLIGHT_TOKEN_LENGTH = 3;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

const NON_WORD_RUN = /[^\p{L}\p{N}_]+/gu;

/** Above this a code point is written as a surrogate pair, two units wide. */
const LAST_SINGLE_UNIT_CODE_POINT = 0xff_ff;

const codePointWidth = (codePoint: number): number =>
  codePoint > LAST_SINGLE_UNIT_CODE_POINT ? 2 : 1;

/**
 * The word code point beginning at `index`, or null when what is there is not
 * one — past either end, or a separator.
 *
 * Read as a code point rather than as a UTF-16 unit: half of an astral letter
 * is not a letter to `\p{L}`, so a unit-wise reader sees a word boundary in
 * the middle of one and lets a token match inside the word that follows it.
 * The index is checked explicitly rather than with `.at()`, whose negative
 * index wraps to the end of the string and would read the last character of
 * the text as the one before its first.
 */
const wordCodePointAt = (text: string, index: number): number | null => {
  if (index < 0 || index >= text.length) {
    return null;
  }
  const codePoint = text.codePointAt(index);
  if (
    codePoint === undefined ||
    !WORD_CHARACTER.test(String.fromCodePoint(codePoint))
  ) {
    return null;
  }
  return codePoint;
};

/**
 * Whether the code point ending at `index` is a word character, stepping back
 * over a surrogate pair rather than landing inside one.
 *
 * `codePointAt` on the head of a pair returns the whole letter, so a value
 * above the single-unit range two units back proves those two units are one
 * astral letter rather than two characters — no surrogate arithmetic needed.
 */
const endsWithWordCharacter = (text: string, index: number): boolean => {
  if (index <= 0) {
    return false;
  }
  const pairStart = index >= 2 ? text.codePointAt(index - 2) : undefined;
  const insidePair =
    pairStart !== undefined && pairStart > LAST_SINGLE_UNIT_CODE_POINT;

  return wordCodePointAt(text, insidePair ? index - 2 : index - 1) !== null;
};

/**
 * The words of a query worth marking, lowercased and without repeats.
 * Punctuation is a separator, so the quotes a reader types around a phrase
 * never become part of a token.
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
 * Where a token matches, as an index into the lowercased text: at the start of
 * a word only, and running to the end of that word.
 *
 * The word-start rule is what keeps a three-letter token from lighting up the
 * middle of unrelated words, and letting the match run to the end of the word
 * is what makes it useful in an inflected language: "odpovědnost" marks
 * "odpovědnosti" whole, rather than marking a fragment and leaving a stray
 * ending behind. Prefix, not substring.
 */
export const wordPrefixMatchEnd = (
  lowered: string,
  index: number,
  tokens: readonly string[],
): number | null => {
  if (endsWithWordCharacter(lowered, index)) {
    return null;
  }
  const matched = tokens.some((token) => lowered.startsWith(token, index));
  if (!matched) {
    return null;
  }
  let end = index;
  for (;;) {
    const codePoint = wordCodePointAt(lowered, end);
    if (codePoint === null) {
      return end;
    }
    end += codePointWidth(codePoint);
  }
};

/** The mark a query's words wear, wherever they are shown. */
export const SEARCH_MARK_CLASS_NAME =
  "text-foreground bg-warning/30 font-medium dark:bg-warning/20";

/**
 * The same mark, reached through a descendant selector, for markup that
 * arrived already highlighted (the search endpoint's own `<mark>` snippets).
 * Spelled out rather than derived from the constant above: Tailwind emits only
 * the classes it can read in the source, so a generated name produces no CSS.
 * `SEARCH_MARK_CLASS_NAME` and this one are checked against each other in
 * `query-marks.test.ts`.
 */
export const SEARCH_MARK_DESCENDANT_CLASS_NAME =
  "[&_mark]:text-foreground [&_mark]:bg-warning/30 [&_mark]:font-medium dark:[&_mark]:bg-warning/20";

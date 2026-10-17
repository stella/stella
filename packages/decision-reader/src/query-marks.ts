import { AhoCorasick } from "#aho-corasick";

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
  for (const word of query
    .toWellFormed()
    .replace(NON_WORD_RUN, " ")
    .split(" ")) {
    const token = word.toLowerCase();
    if (token.length < MIN_HIGHLIGHT_TOKEN_LENGTH || tokens.includes(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
};

type QueryPrefixScan = {
  source: string;
  text: string;
  starts: ReadonlySet<number>;
};

type WordPrefixMatcher = (text: string, index: number) => number | null;

// Rows for the current query share the automaton, while each reader owns its scan.
let compiledQueryPrefix: { key: string; matcher: AhoCorasick } | undefined;

/**
 * Owns a snapshot of the query tokens so caller mutations cannot alter a
 * compiled matcher. Build once per query; the bound matcher scans each piece
 * once while its caller walks UTF-16 positions.
 */
export const createWordPrefixMatcher = (
  tokens: readonly string[],
): WordPrefixMatcher => {
  const patterns = [
    ...new Set(
      tokens
        .map((token) => token.toWellFormed())
        .filter((token) => token.length > 0),
    ),
  ];
  if (patterns.length === 0) {
    return () => null;
  }
  const key = JSON.stringify(patterns);
  if (compiledQueryPrefix?.key !== key) {
    compiledQueryPrefix = { key, matcher: new AhoCorasick(patterns) };
  }
  const matcher = compiledQueryPrefix.matcher;
  let scan: QueryPrefixScan | undefined;

  return (lowered, index) => {
    if (scan?.source !== lowered) {
      const normalized = lowered.toWellFormed();
      scan = {
        source: lowered,
        text: normalized,
        starts: new Set(
          matcher.findOverlappingIter(normalized).map(({ start }) => start),
        ),
      };
    }
    if (endsWithWordCharacter(scan.text, index)) {
      return null;
    }
    if (!scan.starts.has(Math.max(0, Math.trunc(index)))) {
      return null;
    }
    // Prefix matches extend through inflections, stopping at the word end.
    let end = index;
    for (;;) {
      const codePoint = wordCodePointAt(scan.text, end);
      if (codePoint === null) {
        return end;
      }
      end += codePointWidth(codePoint);
    }
  };
};

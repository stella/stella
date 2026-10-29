/**
 * The words a query marks, and how a mark looks.
 *
 * A search answers on two surfaces: the results table, which marks why a row
 * matched, and the reader, which marks the same words inside the decision the
 * row opens. A reader who clicks a result and finds different words marked —
 * or the same words marked differently — reads that as two searches rather
 * than one. So the fold, the tokenisation, the match rule and the mark are one
 * definition here, and neither surface keeps a second.
 *
 * The fold is `@stll/text-normalize`'s search match key, the one every
 * client-side list filter uses: case, accents, `ß`/`ł`/`ø`, ligatures and
 * Arabic variants are ignored alike, so `strasse` finds `Straße` in the
 * reader exactly as it does in a picker.
 */

import { panic } from "better-result";

import {
  foldSearchMatchTextWithOffsets,
  spacedLetterRunRegex,
} from "@stll/text-normalize";

/**
 * Below this a token matches too much to mean anything: in an inflected
 * language two letters are a preposition or a case ending, and marking every
 * occurrence of one reads as noise rather than as an answer.
 */
export const MIN_HIGHLIGHT_TOKEN_LENGTH = 3;

/** What a word is made of; everything else separates words. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

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
 * A text on the axis a query is matched on: its words folded by the shared
 * search match key and one space apart, with the original-text range of the
 * character every folded UTF-16 unit came from.
 */
export type FoldedMarkText = {
  /** Original end (exclusive) of the character each folded unit came from. */
  readonly endMap: readonly number[];
  /** Original start of the character each folded unit came from. */
  readonly startMap: readonly number[];
  readonly text: string;
};

/**
 * The spaces inside spaced-out emphasis (`r o z h o d o l`) that join their
 * letters into one word rather than separating them, by original index.
 */
const spacedLetterJoins = (text: string): ReadonlySet<number> => {
  const joins = new Set<number>();
  for (const match of text.matchAll(spacedLetterRunRegex())) {
    const run = match[0];
    for (let offset = 1; offset < run.length; offset += 1) {
      const before = run[offset - 1];
      if (
        run[offset] === " " &&
        before !== undefined &&
        WORD_CHARACTER.test(before)
      ) {
        joins.add(match.index + offset);
      }
    }
  }
  return joins;
};

/**
 * Fold a text for marking: `foldSearchMatchTextWithOffsets` (the client-wide
 * match key, with each folded unit's original range), then every run of
 * separators collapsed to one space, leading and trailing ones dropped, and
 * spaced-out letters joined.
 *
 * A separator inside one original character's own folding never splits it:
 * `½` folds to `1⁄2`, and marking `1` and `2` as two words would draw two
 * marks over one character. So every original character belongs to at most
 * one folded word, and the original ranges of the words never overlap.
 */
export const foldMarkText = (text: string): FoldedMarkText => {
  const joins = spacedLetterJoins(text);
  const folded = foldSearchMatchTextWithOffsets(text);
  const parts: string[] = [];
  const startMap: number[] = [];
  const endMap: number[] = [];
  const push = (part: string, start: number, end: number) => {
    parts.push(part);
    // One entry per UTF-16 unit, since `String#indexOf` and word spans count
    // units: an astral letter takes two.
    let units = part.length;
    while (units > 0) {
      startMap.push(start);
      endMap.push(end);
      units -= 1;
    }
  };
  // The first separator after the last word character, held until the next
  // word character shows whether it separates two words at all.
  let pendingSeparatorStart: number | null = null;
  let pendingSeparatorEnd = 0;
  let lastWordStart: number | null = null;
  let unit = 0;
  for (const character of folded.text) {
    const range =
      folded.originalRanges.at(unit) ??
      panic("Folded search text has no original range for one of its units");
    unit += character.length;
    if (!WORD_CHARACTER.test(character)) {
      if (
        lastWordStart !== null &&
        pendingSeparatorStart === null &&
        !joins.has(range.start)
      ) {
        pendingSeparatorStart = range.start;
        pendingSeparatorEnd = range.end;
      }
      continue;
    }
    if (pendingSeparatorStart !== null && lastWordStart !== range.start) {
      push(" ", pendingSeparatorStart, pendingSeparatorEnd);
    }
    pendingSeparatorStart = null;
    lastWordStart = range.start;
    push(character, range.start, range.end);
  }
  return { endMap, startMap, text: parts.join("") };
};

const QUERY_MARK_TOKENS: unique symbol = Symbol("QueryMarkTokens");

/**
 * The words of a query, on the folded axis. Only `queryHighlightTokens`
 * produces them (the brand's symbol is not exported), so a hand-written token
 * list, lowercased but not folded and so never matching folded text, cannot
 * reach a marker.
 */
export type QueryMarkTokens = readonly string[] & {
  readonly [QUERY_MARK_TOKENS]: true;
};

/**
 * The words of a query, folded and without repeats, from the shortest that
 * counts. Punctuation is a separator, so the quotes a reader types around a
 * phrase never become part of a token.
 */
const foldedQueryWords = (
  query: string | undefined,
  minimumLength: number,
): string[] => {
  const tokens: string[] = [];
  if (query !== undefined) {
    const { text } = foldMarkText(query);
    for (const { end, start } of wordSpans(text)) {
      const token = text.slice(start, end);
      if (token.length >= minimumLength && !tokens.includes(token)) {
        tokens.push(token);
      }
    }
  }
  return tokens;
};

/**
 * The words of a search query worth marking in its results: the query was
 * asked of the corpus, so its short words are noise there.
 */
export const queryHighlightTokens = (
  query: string | undefined,
): QueryMarkTokens =>
  Object.assign(foldedQueryWords(query, MIN_HIGHLIGHT_TOKEN_LENGTH), {
    [QUERY_MARK_TOKENS]: true as const,
  });

/**
 * The words a reader typed to find in the text before them, every one of
 * them: "1" is how a reader looks for § 1, and a find that drops it answers
 * "no results" over a page that shows it.
 */
export const queryFindTokens = (query: string | undefined): QueryMarkTokens =>
  Object.assign(foldedQueryWords(query, 1), {
    [QUERY_MARK_TOKENS]: true as const,
  });

/**
 * Where a token matches, as an index into the folded text: at the start of a
 * word only, and running to the end of that word.
 *
 * The word-start rule is what keeps a three-letter token from lighting up the
 * middle of unrelated words, and letting the match run to the end of the word
 * is what makes it useful in an inflected language: "odpovědnost" marks
 * "odpovědnosti" whole, rather than marking a fragment and leaving a stray
 * ending behind. Prefix, not substring.
 */
export const wordPrefixMatchEnd = (
  folded: string,
  index: number,
  tokens: QueryMarkTokens,
): number | null => {
  if (endsWithWordCharacter(folded, index)) {
    return null;
  }
  const matched = tokens.some((token) => folded.startsWith(token, index));
  if (!matched) {
    return null;
  }
  let end = index;
  for (;;) {
    const codePoint = wordCodePointAt(folded, end);
    if (codePoint === null) {
      return end;
    }
    end += codePointWidth(codePoint);
  }
};

/** One word of a folded text, or one marked run of an original text, as offsets into it. */
export type WordSpan = { end: number; start: number };

/**
 * Every place {@link wordPrefixMatchEnd} can mark, with the end it would mark
 * to: each word, from its first code point to its last.
 *
 * A match starts only where a word starts and always runs to that word's end,
 * so the words are the whole set of candidate marks. Listing them once lets a
 * reader index its text a single time and answer each query by looking the
 * query's tokens up among the words, instead of scanning every character
 * again.
 */
export const wordSpans = (folded: string): WordSpan[] => {
  const spans: WordSpan[] = [];
  let index = 0;
  while (index < folded.length) {
    const codePoint = wordCodePointAt(folded, index);
    if (codePoint === null || endsWithWordCharacter(folded, index)) {
      index += 1;
      continue;
    }
    let end = index;
    for (;;) {
      const next = wordCodePointAt(folded, end);
      if (next === null) {
        break;
      }
      end += codePointWidth(next);
    }
    spans.push({ end, start: index });
    index = end;
  }
  return spans;
};

/** Where one folded word sits in the original text it was folded from. */
export const originalWordRange = (
  folded: FoldedMarkText,
  { end, start }: WordSpan,
): WordSpan => ({
  start:
    folded.startMap.at(start) ??
    panic("A folded word starts outside its folded text"),
  end:
    folded.endMap.at(end - 1) ??
    panic("A folded word ends outside its folded text"),
});

type MarkableText = { folded: FoldedMarkText; words: readonly WordSpan[] };

// A results page re-marks the same headnotes on every render. Folding is the
// costly step and depends only on the text: keeping the folds turns marking
// fifty 560-character headnotes from about 4 ms into about 0.3 ms. The fold is
// pure, so the cache is unobservable; clearing it whole when full bounds its
// memory without an eviction policy.
const MARKABLE_TEXT_CACHE_LIMIT = 256;
const markableTexts = new Map<string, MarkableText>();

const markableText = (text: string): MarkableText => {
  const cached = markableTexts.get(text);
  if (cached !== undefined) {
    return cached;
  }
  if (markableTexts.size >= MARKABLE_TEXT_CACHE_LIMIT) {
    markableTexts.clear();
  }
  const folded = foldMarkText(text);
  const entry = { folded, words: wordSpans(folded.text) };
  markableTexts.set(text, entry);
  return entry;
};

/**
 * The runs of an original text the query's words mark, in order and never
 * overlapping: the same words, by the same rule, that the reader's find marks
 * in the same text.
 */
export const queryMarkRanges = (
  text: string,
  tokens: QueryMarkTokens,
): WordSpan[] => {
  if (tokens.length === 0) {
    return [];
  }
  const { folded, words } = markableText(text);
  const ranges: WordSpan[] = [];
  for (const span of words) {
    if (wordPrefixMatchEnd(folded.text, span.start, tokens) !== null) {
      ranges.push(originalWordRange(folded, span));
    }
  }
  return ranges;
};

/** A query with nothing to mark: a browse listing, a saved research table. */
export const NO_QUERY_MARK_TOKENS = queryHighlightTokens(undefined);

/**
 * Cut a fragment out of a corpus passage and mark the query's matches in it.
 *
 * Takes the passage text, the query's tokens (`tokenizeCorpusFreeText`) and the
 * language both sides are stemmed in. Returns the fragment twice: as
 * HTML-escaped text with `<mark>` around each matched run, and as plain text.
 *
 * A passage word matches a query word when their folded surfaces are equal or
 * their stems are; a phrase token matches consecutive passage words. Splitting,
 * folding and stemming come from `corpus-tokens`, `@stll/text-normalize` and
 * `morphology/stem`. Pure.
 */

import { Buffer } from "node:buffer";

import { foldToAscii } from "@stll/text-normalize";

import { CORPUS_TOKEN_LENGTH_LIMIT_BYTES } from "@/api/lib/legal-search/corpus-index-config";
import type { CorpusQueryToken } from "@/api/lib/legal-search/corpus-query";
import type { CorpusTokenSpan } from "@/api/lib/legal-search/corpus-tokens";
import {
  corpusTokens,
  corpusTokenSpans,
  normalizeCorpusText,
} from "@/api/lib/legal-search/corpus-tokens";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import { stemLegalTerm } from "@/api/lib/legal-search/morphology/stem";
import { escapeSearchHtml } from "@/api/lib/search/highlight";

/** Characters one fragment may span, unless a caller passes `maxChars`. */
export const CORPUS_SNIPPET_MAX_CHARS = 100;

/**
 * The form terms are compared in: lower-cased, then ASCII-folded, matching the
 * filter order of the index's `folded` tokenizer.
 */
export const foldCorpusTerm = (value: string): string =>
  foldToAscii(value.toLowerCase());

/**
 * Whether the index holds this folded token at all: `remove_long` drops the
 * rest, so an over-long token (an OCR run) matches nothing on either side.
 */
const isIndexedTerm = (folded: string): boolean =>
  Buffer.byteLength(folded, "utf-8") < CORPUS_TOKEN_LENGTH_LIMIT_BYTES;

/** A word of the query, as the two forms a passage word is compared against. */
type QueryWord = {
  folded: string;
  /** Empty when the language has no stemmer. */
  stem: string;
};

/** One query token's words, in order; a phrase carries more than one. */
type QueryTermWords = readonly QueryWord[];

/** A passage word, folded and stemmed once so the scan below can be a scan. */
type PassageWord = CorpusTokenSpan & {
  folded: string;
  stem: string;
  /** False for a token `remove_long` drops; such a word matches nothing. */
  indexed: boolean;
};

const stemFolded = (
  value: string,
  language: MorphologyLanguage | null,
): string =>
  language === null ? "" : foldCorpusTerm(stemLegalTerm(value, language));

const queryTermWords = (
  tokens: readonly CorpusQueryToken[],
  language: MorphologyLanguage | null,
): QueryTermWords[] =>
  tokens.flatMap((token) => {
    const words = corpusTokens(token.value).map((word) => ({
      folded: foldCorpusTerm(word),
      stem: stemFolded(word, language),
    }));
    // One dropped word makes the whole term unmatchable: a term is its word,
    // and a phrase needs every one of its words to match adjacently.
    return words.length === 0 ||
      !words.every(({ folded }) => isIndexedTerm(folded))
      ? []
      : [words];
  });

const passageWords = (
  text: string,
  language: MorphologyLanguage | null,
): PassageWord[] =>
  corpusTokenSpans(text).map((span) => {
    const folded = foldCorpusTerm(span.value);
    return {
      value: span.value,
      start: span.start,
      end: span.end,
      folded,
      stem: stemFolded(span.value, language),
      indexed: isIndexedTerm(folded),
    };
  });

const wordMatches = (word: PassageWord, queryWord: QueryWord): boolean =>
  word.indexed &&
  (word.folded === queryWord.folded ||
    (queryWord.stem !== "" && word.stem === queryWord.stem));

/** One term matching a run of passage words; `end` is exclusive. */
type TermMatch = { termIndex: number; start: number; end: number };

const termMatches = (
  words: readonly PassageWord[],
  terms: readonly QueryTermWords[],
): TermMatch[] => {
  const matches: TermMatch[] = [];
  for (let start = 0; start < words.length; start += 1) {
    for (const [termIndex, term] of terms.entries()) {
      if (term.length > words.length - start) {
        continue;
      }
      const matched = term.every((queryWord, offset) => {
        const word = words.at(start + offset);
        return word !== undefined && wordMatches(word, queryWord);
      });
      if (matched) {
        matches.push({ termIndex, start, end: start + term.length });
      }
    }
  }
  return matches;
};

/** A candidate fragment, as a half-open range of passage words. */
type Window = { start: number; end: number; terms: number; matches: number };

/**
 * The window a fragment is cut from: most distinct matched terms, then most
 * matches, then earliest. A passage with no match therefore yields its opening
 * window.
 *
 * Each window is grown to the character budget before it is scored. The budget
 * edge never moves backwards as `start` advances, so the scan is linear; a
 * match that begins at `start` and outruns the budget extends that one window
 * past it, the way an over-long single word forms a window of its own.
 */
const bestWindow = (
  words: readonly PassageWord[],
  matches: readonly TermMatch[],
  maxChars: number,
): Window | null => {
  if (words.length === 0) {
    return null;
  }
  const spanChars = (start: number, end: number): number => {
    const startWord = words.at(start);
    const endWord = words.at(end - 1);
    return startWord === undefined || endWord === undefined
      ? 0
      : endWord.end - startWord.start;
  };

  let best: Window | null = null;
  let budgetEnd = 0;
  // Matches are produced in start order, so a cursor over them is enough to
  // reach the ones a window can hold without rescanning the passage per window.
  let cursor = 0;
  for (let start = 0; start < words.length; start += 1) {
    while (
      cursor < matches.length &&
      (matches.at(cursor)?.start ?? 0) < start
    ) {
      cursor += 1;
    }
    // A word longer than the whole budget still forms a window of its own.
    budgetEnd = Math.max(budgetEnd, start + 1);
    while (
      budgetEnd < words.length &&
      spanChars(start, budgetEnd + 1) <= maxChars
    ) {
      budgetEnd += 1;
    }
    // Kept out of `budgetEnd` so the widening applies to this window only.
    let end = budgetEnd;
    for (let index = cursor; index < matches.length; index += 1) {
      const match = matches.at(index);
      if (match === undefined || match.start > start) {
        break;
      }
      end = Math.max(end, match.end);
    }

    const seen = new Set<number>();
    let held = 0;
    for (let index = cursor; index < matches.length; index += 1) {
      const match = matches.at(index);
      if (match === undefined || match.start >= end) {
        break;
      }
      if (match.end > end) {
        continue;
      }
      seen.add(match.termIndex);
      held += 1;
    }
    if (
      best === null ||
      seen.size > best.terms ||
      (seen.size === best.terms && held > best.matches)
    ) {
      best = { start, end, terms: seen.size, matches: held };
    }
  }
  return best;
};

/** A character range of the passage that a `<mark>` covers. */
type MarkRange = { start: number; end: number };

const markRanges = (
  words: readonly PassageWord[],
  matches: readonly TermMatch[],
  window: Window,
): MarkRange[] => {
  const ranges: MarkRange[] = [];
  for (const match of matches) {
    if (match.start < window.start || match.end > window.end) {
      continue;
    }
    const startWord = words.at(match.start);
    const endWord = words.at(match.end - 1);
    if (startWord === undefined || endWord === undefined) {
      continue;
    }
    // Matches arrive in start order, so an overlap can only be with the last
    // range; overlapping ranges merge, because marks never nest.
    const previous = ranges.at(-1);
    if (previous !== undefined && startWord.start <= previous.end) {
      previous.end = Math.max(previous.end, endWord.end);
      continue;
    }
    ranges.push({ start: startWord.start, end: endWord.end });
  }
  return ranges;
};

const markFragment = (
  text: string,
  from: number,
  to: number,
  ranges: readonly MarkRange[],
): string => {
  let html = "";
  let cursor = from;
  for (const range of ranges) {
    html += escapeSearchHtml(text.slice(cursor, range.start));
    html += `<mark>${escapeSearchHtml(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeSearchHtml(text.slice(cursor, to));
};

type CorpusPassageFragment = {
  /** HTML-escaped, with `<mark>` around each matched run. */
  html: string;
  /** The same fragment as plain text. */
  text: string;
};

type HighlightCorpusPassageOptions = {
  /** The passage as the index holds it. */
  passage: string;
  /** The query's tokens, from `tokenizeCorpusFreeText`. */
  tokens: readonly CorpusQueryToken[];
  /** The language both sides are stemmed in; null stems neither. */
  language: MorphologyLanguage | null;
  maxChars?: number | undefined;
};

/**
 * The fragment of `passage` with the best match coverage for `tokens`.
 *
 * Cuts on word boundaries, so no fragment ends inside a word; an empty passage
 * yields an empty fragment.
 */
export const highlightCorpusPassage = ({
  passage,
  tokens,
  language,
  maxChars = CORPUS_SNIPPET_MAX_CHARS,
}: HighlightCorpusPassageOptions): CorpusPassageFragment => {
  // The offsets below index the NFC form, so the fragment is cut from it too.
  const text = normalizeCorpusText(passage);
  const words = passageWords(text, language);
  const matches = termMatches(words, queryTermWords(tokens, language));
  const window = bestWindow(words, matches, maxChars);
  if (window === null) {
    return { html: "", text: "" };
  }

  const from = words.at(window.start)?.start ?? 0;
  const to = words.at(window.end - 1)?.end ?? 0;
  const ranges = markRanges(words, matches, window);
  return {
    html: markFragment(text, from, to, ranges),
    text: text.slice(from, to),
  };
};

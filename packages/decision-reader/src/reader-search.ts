import {
  applyArabicFolds,
  normalizeUnicode,
  spacedLetterRunRegex,
  stripDiacritics,
} from "@stll/text-normalize";

import { queryHighlightTokens, wordSpans } from "./query-marks";

export type SearchPiece = {
  id: string;
  text: string;
};

/**
 * What a marked span of a reader's text means. A search match carries its
 * index so the find bar can step to it; a comparison marks what one version
 * added or removed.
 */
export type ReaderMark =
  | { type: "search"; matchIndex: number }
  | { type: "inserted" }
  | { type: "deleted" };

/** A marked span of one piece's plain text, as offsets into it. */
export type ReaderMarkRange = ReaderMark & { end: number; start: number };

export type ReaderSearchMatchRange = Extract<
  ReaderMarkRange,
  { type: "search" }
>;

export type SearchResults = {
  matchCount: number;
  rangesByPieceId: Record<string, ReaderSearchMatchRange[]>;
};

const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;

type NormalizedText = {
  endMap: number[];
  startMap: number[];
  text: string;
};

const normalizeReaderSearchText = (text: string): NormalizedText => {
  const normalizedChars: string[] = [];
  const startMap: number[] = [];
  const endMap: number[] = [];

  let originalIndex = 0;
  let lastWasSeparator = true;

  // Mark every space that sits between single letters inside a
  // spaced-letter run — we'll treat those spaces as letter-like
  // so the letters collapse into one searchable word while each
  // letter's startMap/endMap still points at its original char.
  const dropSpaceAt = new Set<number>();
  for (const match of text.matchAll(spacedLetterRunRegex())) {
    const matchStart = match.index;
    const matched = match[0];
    for (let i = 0; i < matched.length; i++) {
      if (matched[i] === " ") {
        const ch = matched[i - 1];
        if (ch !== undefined && ch !== " " && LETTER_OR_NUMBER_RE.test(ch)) {
          dropSpaceAt.add(matchStart + i);
        }
      }
    }
  }

  // startMap/endMap are indexed by UTF-16 code units of the
  // joined normalized text, because `String.indexOf` returns
  // code-unit offsets. When we append a character that spans
  // multiple code units (e.g., an astral-plane letter encoded
  // as a surrogate pair), we push one map entry per unit so
  // `startMap[matchStart]` and `endMap[matchEnd - 1]` stay
  // valid for every code-unit index the matcher can produce.
  const pushEntry = (char: string, origStart: number, origEnd: number) => {
    normalizedChars.push(char);
    // Push one map entry per UTF-16 code unit the char
    // occupies (2 for surrogate pairs, 1 otherwise).
    // `char.length` returns code units, not code points.
    const units = Array.from<number>({ length: char.length });
    startMap.push(...units.fill(origStart));
    endMap.push(...units.fill(origEnd));
  };

  for (const rawChar of text) {
    // NFKC folds presentation forms to canonical letters; applyArabicFolds
    // then folds Arabic variants (before NFD, so a composed alef-hamza is
    // not split first); stripDiacritics (NFD + mark removal) strips the
    // remaining Latin/Arabic combining diacritics.
    const normalizedChar = stripDiacritics(
      applyArabicFolds(normalizeUnicode(rawChar, "NFKC")),
    );
    const origStart = originalIndex;
    const origEnd = originalIndex + rawChar.length;

    for (const candidate of normalizedChar) {
      if (LETTER_OR_NUMBER_RE.test(candidate)) {
        pushEntry(candidate, origStart, origEnd);
        lastWasSeparator = false;
        continue;
      }

      // Spaces inside a spaced-letter run are suppressed entirely
      // so "r o z h o d o l" normalizes to "rozhodol".
      if (rawChar === " " && dropSpaceAt.has(originalIndex)) {
        continue;
      }

      if (lastWasSeparator || normalizedChars.length === 0) {
        continue;
      }

      pushEntry(" ", origStart, origEnd);
      lastWasSeparator = true;
    }

    originalIndex += rawChar.length;
  }

  if (normalizedChars.at(-1) === " ") {
    normalizedChars.pop();
    startMap.pop();
    endMap.pop();
  }

  // Fold with the invariant locale so matching stays stable
  // regardless of the browser's locale. `toLocaleLowerCase()`
  // folds "I" → "ı" on Turkish systems, which would make
  // "INDICTMENT" vs "indictment" look like different strings
  // to two users opening the same decision.
  //
  // Preferred path: fold the whole joined string so
  // context-sensitive rules (Greek final sigma: "Σ" at end of
  // word lowers to "ς", elsewhere to "σ") apply. Keep that
  // result only if it stays the same UTF-16 length as the
  // pre-fold text; otherwise the pre-built startMap/endMap no
  // longer align. In that rare case, fall back to per-char
  // folding and rebuild the maps alongside it.
  const joined = normalizedChars.join("");
  const loweredJoined = joined.toLowerCase();
  if (loweredJoined.length === joined.length) {
    return { text: loweredJoined, startMap, endMap };
  }

  const loweredStartMap: number[] = [];
  const loweredEndMap: number[] = [];
  const loweredParts: string[] = [];
  let unitCursor = 0;
  for (const char of normalizedChars) {
    const lowered = char.toLowerCase();
    loweredParts.push(lowered);
    const origStart = startMap[unitCursor] ?? 0;
    const origEnd = endMap[unitCursor] ?? 0;
    const units = Array.from<number>({ length: lowered.length });
    loweredStartMap.push(...units.fill(origStart));
    loweredEndMap.push(...units.fill(origEnd));
    unitCursor += char.length;
  }

  return {
    text: loweredParts.join(""),
    startMap: loweredStartMap,
    endMap: loweredEndMap,
  };
};

/**
 * The query's words, on the same axis the text is matched on. Normalizing
 * before tokenising is what lets a reader type "nahrada skody" and reach
 * "Náhrada škody": the fold happens once, and the tokeniser then splits the
 * folded string by the rule the results table splits the same query by.
 */
const readerQueryTokens = (query: string): readonly string[] =>
  queryHighlightTokens(normalizeReaderSearchText(query).text);

/** A piece as the index holds it: folded once, with its words listed. */
type IndexedPiece = {
  id: string;
  normalized: NormalizedText;
};

/**
 * Every word of a reader's text, folded once.
 *
 * Folding is the costly part of a search (each character is normalized,
 * diacritics are stripped, the text is lowercased), and it depends only on
 * the text, never on the query. The index does it once per text and sorts
 * the words, so each query is a lookup of its tokens among them: a token's
 * matches are the words it is a prefix of, and those sit next to each other
 * in sorted order.
 */
export type ReaderSearchIndex = {
  readonly pieces: readonly IndexedPiece[];
  /** Word i is `pieces[wordPiece[i]].normalized.text` from `wordStart[i]` to `wordEnd[i]`. */
  readonly wordEnd: Int32Array;
  readonly wordPiece: Int32Array;
  readonly wordStart: Int32Array;
  /** Word positions, ordered by the word's text. */
  readonly wordsByText: Int32Array;
  readonly wordText: readonly string[];
};

export const createReaderSearchIndex = (
  pieces: readonly SearchPiece[],
): ReaderSearchIndex => {
  const indexed: IndexedPiece[] = [];
  const wordText: string[] = [];
  const piecesOfWords: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [pieceIndex, piece] of pieces.entries()) {
    const normalized = normalizeReaderSearchText(piece.text);
    indexed.push({ id: piece.id, normalized });
    for (const span of wordSpans(normalized.text)) {
      wordText.push(normalized.text.slice(span.start, span.end));
      piecesOfWords.push(pieceIndex);
      starts.push(span.start);
      ends.push(span.end);
    }
  }
  const wordsByText = Int32Array.from(wordText.keys());
  // Code-unit order, the order `startsWith` agrees with: every word a token
  // is a prefix of follows the token's own position without a gap.
  wordsByText.sort((left, right) => {
    const a = wordText[left] ?? "";
    const b = wordText[right] ?? "";
    if (a === b) {
      return left - right;
    }
    return a < b ? -1 : 1;
  });
  return {
    pieces: indexed,
    wordEnd: Int32Array.from(ends),
    wordPiece: Int32Array.from(piecesOfWords),
    wordStart: Int32Array.from(starts),
    wordsByText,
    wordText,
  };
};

/** The first sorted position whose word is not below `token`. */
const firstWordAtOrAfter = (
  index: ReaderSearchIndex,
  token: string,
): number => {
  let low = 0;
  let high = index.wordsByText.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const word = index.wordText[index.wordsByText[middle] ?? 0] ?? "";
    if (word < token) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

/**
 * Every word of the query, wherever it starts a word in the text.
 *
 * Word-prefix rather than substring, so a multi-word query marks its words
 * where the text actually uses them — an inflected corpus almost never repeats
 * the reader's phrase verbatim, and a phrase that does appear is marked
 * anyway, one word at a time. Matches are numbered in piece order and then in
 * position order, so a match index is a position in the document.
 *
 * The work is the query's tokens looked up in the index plus the matches
 * found, not the length of the text.
 */
export const searchReaderIndex = (
  index: ReaderSearchIndex,
  query: string,
): SearchResults => {
  const tokens = readerQueryTokens(query);
  if (tokens.length === 0) {
    return { matchCount: 0, rangesByPieceId: {} };
  }

  // A word two tokens both start is still one match.
  const hits = new Set<number>();
  for (const token of tokens) {
    for (
      let sorted = firstWordAtOrAfter(index, token);
      sorted < index.wordsByText.length;
      sorted += 1
    ) {
      const word = index.wordsByText[sorted] ?? 0;
      if (!(index.wordText[word] ?? "").startsWith(token)) {
        break;
      }
      hits.add(word);
    }
  }
  // Words were listed piece by piece and left to right, so their positions
  // are document order.
  const ordered = Int32Array.from(hits).toSorted();

  const rangesByPieceId: Record<string, ReaderSearchMatchRange[]> = {};
  let matchCount = 0;
  for (const word of ordered) {
    const piece = index.pieces[index.wordPiece[word] ?? 0];
    if (piece === undefined) {
      continue;
    }
    const originalStart = piece.normalized.startMap[index.wordStart[word] ?? 0];
    const originalEnd = piece.normalized.endMap[(index.wordEnd[word] ?? 0) - 1];
    if (originalStart === undefined || originalEnd === undefined) {
      continue;
    }
    const range: ReaderSearchMatchRange = {
      type: "search",
      start: originalStart,
      end: originalEnd,
      matchIndex: matchCount,
    };
    const existingRanges = rangesByPieceId[piece.id];
    if (existingRanges) {
      existingRanges.push(range);
    } else {
      rangesByPieceId[piece.id] = [range];
    }
    matchCount += 1;
  }

  return {
    matchCount,
    rangesByPieceId,
  };
};

/** One search over pieces read once: the index built and queried in a step. */
export const buildSearchResults = ({
  pieces,
  query,
}: {
  pieces: SearchPiece[];
  query: string;
}): SearchResults => searchReaderIndex(createReaderSearchIndex(pieces), query);

import {
  foldMarkText,
  originalWordRange,
  queryFindTokens,
  wordSpans,
} from "./query-marks";
import type { FoldedMarkText } from "./query-marks";

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

/** A piece as the index holds it: folded once, with its words listed. */
type IndexedPiece = {
  id: string;
  folded: FoldedMarkText;
};

/**
 * Every word of a reader's text, folded once.
 *
 * Folding is the costly part of a search (each character is decomposed and
 * its accents and case are folded away), and it depends only on
 * the text, never on the query. The index does it once per text and sorts
 * the words, so each query is a lookup of its tokens among them: a token's
 * matches are the words it is a prefix of, and those sit next to each other
 * in sorted order.
 */
export type ReaderSearchIndex = {
  readonly pieces: readonly IndexedPiece[];
  /** Word i is `pieces[wordPiece[i]].folded.text` from `wordStart[i]` to `wordEnd[i]`. */
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
    const folded = foldMarkText(piece.text);
    indexed.push({ id: piece.id, folded });
    for (const span of wordSpans(folded.text)) {
      wordText.push(folded.text.slice(span.start, span.end));
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
  // Folding before tokenising is what lets a reader type "nahrada skody" and
  // reach "Náhrada škody": the tokeniser then splits the folded string by the
  // rule the results table splits the same query by, keeping the short words
  // the table leaves out: a reader finding "1" is looking for § 1.
  const tokens = queryFindTokens(query);
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
    const { end, start } = originalWordRange(piece.folded, {
      start: index.wordStart[word] ?? 0,
      end: index.wordEnd[word] ?? 0,
    });
    const range: ReaderSearchMatchRange = {
      type: "search",
      start,
      end,
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

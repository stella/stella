/**
 * Where a reader's mark sits in a document whose structure may have changed
 * since it was made.
 *
 * A mark is stored as a position (a block anchor and offsets into that
 * block's text) and as the words themselves with a little of the text on
 * either side, the shape of a W3C `TextQuoteSelector`. A position alone is
 * not an identity: a re-parse that joins or splits paragraphs renumbers the
 * anchors after it, so `p-2` can name another paragraph and its offsets
 * other words. The quote is what the reader marked, so it decides: a mark is
 * placed where its quote is, or, when the quote is gone or the text gives
 * no single place for it, reported as orphaned. It is never drawn on words
 * it was not made on.
 *
 * Matching ignores whitespace: a plain space for a non-breaking one, a line
 * break a re-parse turned into a paragraph boundary or a space, a
 * letter-spaced heading. Every other character must agree.
 */

import { panic } from "better-result";

/**
 * How much text either side of a quote is kept to tell its occurrences
 * apart, in UTF-16 code units. The W3C selector's own default.
 */
export const READER_TEXT_QUOTE_CONTEXT_LENGTH = 32;

/** A run of text the reader anchors marks in, with its anchor. */
export type ReaderTextPiece = { anchorId: string; text: string };

/** A stored mark's position and the words it was made on. */
export type ReaderTextQuoteSelector = {
  blockAnchorId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  /** The text just before the quote in its block; empty at the block start. */
  quotePrefix: string;
  /** The text just after the quote in its block; empty at the block end. */
  quoteSuffix: string;
};

/**
 * Why a mark has no place in the current text: its words are not there (or
 * only where the text around them contradicts the stored context), or they
 * are in several places the stored context cannot tell apart.
 */
export const READER_TEXT_QUOTE_ORPHAN_REASONS = [
  "quote_not_found",
  "quote_ambiguous",
] as const;
export type ReaderTextQuoteOrphanReason =
  (typeof READER_TEXT_QUOTE_ORPHAN_REASONS)[number];

type ReaderTextPosition = {
  blockAnchorId: string;
  startOffset: number;
  endOffset: number;
};

export type ReaderTextQuotePlacement =
  | ({ status: "placed" } & ReaderTextPosition)
  | { status: "orphaned"; reason: ReaderTextQuoteOrphanReason };

type CompactText = {
  text: string;
  /** UTF-16 offset in the raw text of every compact code unit. */
  rawIndex: number[];
};

const WHITESPACE = /\s/u;

/**
 * The text with every whitespace character dropped, one entry per UTF-16
 * code unit (the unit a browser selection measures, and the unit `indexOf`
 * returns). Both sides are read as Unicode scalar values first: an isolated
 * surrogate becomes U+FFFD (one unit, so offsets are unchanged) and can never
 * match half of a surrogate pair. Every whitespace character is in the BMP,
 * so dropping one never splits a pair.
 */
const compact = (raw: string): CompactText => {
  const wellFormed = raw.toWellFormed();
  let text = "";
  const rawIndex: number[] = [];
  for (let index = 0; index < wellFormed.length; index += 1) {
    const unit = wellFormed.charAt(index);
    if (WHITESPACE.test(unit)) {
      continue;
    }
    text += unit;
    rawIndex.push(index);
  }
  return { text, rawIndex };
};

const compactText = (raw: string): string => compact(raw).text;

type CompactSpan = { start: number; end: number };

const compactOccurrences = (haystack: string, needle: string): number[] => {
  const occurrences: number[] = [];
  if (needle.length === 0) {
    return occurrences;
  }
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    occurrences.push(at);
  }
  return occurrences;
};

/** Raw offsets of a compact match: its first and past its last character. */
const rawSpanOf = (
  { rawIndex }: CompactText,
  { start, end }: CompactSpan,
): { startOffset: number; endOffset: number } => {
  const startOffset = rawIndex[start];
  const last = rawIndex[end - 1];
  if (startOffset === undefined || last === undefined) {
    return panic("A compact match lies outside its own text");
  }
  return { startOffset, endOffset: last + 1 };
};

/** Every place `quote` occurs in `raw`, as offsets into `raw`. */
export const readerTextQuoteOccurrences = (
  raw: string,
  quote: string,
): { startOffset: number; endOffset: number }[] => {
  const haystack = compact(raw);
  const needle = compactText(quote);
  return compactOccurrences(haystack.text, needle).map((start) =>
    rawSpanOf(haystack, { start, end: start + needle.length }),
  );
};

const isLowSurrogate = (unit: number): boolean =>
  unit >= 0xdc_00 && unit <= 0xdf_ff;

/**
 * The context a new mark stores: up to the context length of the block's
 * text on either side of the quote, never cut through a surrogate pair, and
 * well formed so the database can hold it.
 */
export const readerTextQuoteContext = (
  text: string,
  { startOffset, endOffset }: { startOffset: number; endOffset: number },
): { quotePrefix: string; quoteSuffix: string } => {
  let from = Math.max(0, startOffset - READER_TEXT_QUOTE_CONTEXT_LENGTH);
  if (from > 0 && isLowSurrogate(text.codePointAt(from) ?? 0)) {
    from += 1;
  }
  let to = Math.min(text.length, endOffset + READER_TEXT_QUOTE_CONTEXT_LENGTH);
  if (to < text.length && isLowSurrogate(text.codePointAt(to) ?? 0)) {
    to -= 1;
  }
  return {
    quotePrefix: text.slice(from, startOffset).toWellFormed(),
    quoteSuffix: text.slice(endOffset, to).toWellFormed(),
  };
};

/**
 * Whether the words at a position are the quote. The check every drawn mark
 * passes, whoever placed it.
 */
export const readerTextQuoteMatchesAt = (
  text: string,
  {
    endOffset,
    quote,
    startOffset,
  }: { startOffset: number; endOffset: number; quote: string },
): boolean => {
  if (startOffset < 0 || endOffset > text.length || endOffset <= startOffset) {
    return false;
  }
  const needle = compactText(quote);
  return (
    needle.length > 0 &&
    compactText(text.slice(startOffset, endOffset)) === needle
  );
};

/**
 * Whether the stored context agrees with the text around an occurrence.
 * Only the overlap is compared, which is the whole stored context except at
 * the start or end of the document, where there is less text to compare.
 */
const contextAgrees = (
  stored: string,
  actual: string,
  side: "before" | "after",
): boolean => {
  const length = Math.min(stored.length, actual.length);
  return side === "before"
    ? stored.slice(stored.length - length) ===
        actual.slice(actual.length - length)
    : stored.slice(0, length) === actual.slice(0, length);
};

type IndexedPiece = {
  anchorId: string;
  compact: CompactText;
  /** Where the piece's compact text starts in the document's. */
  streamStart: number;
};

type StoredQuote = { needle: string; prefix: string; suffix: string };

/** The compact span a stored raw position covers, if it is the quote. */
const storedSpanIn = (
  { rawIndex, text }: CompactText,
  { startOffset, endOffset }: ReaderTextQuoteSelector,
  needle: string,
): CompactSpan | null => {
  const start = rawIndex.findIndex((index) => index >= startOffset);
  if (start === -1) {
    return null;
  }
  const end = start + needle.length;
  const last = rawIndex[end - 1];
  const next = rawIndex[end];
  // The stored span holds exactly the quote: no word of it falls outside,
  // and no other word falls inside.
  if (
    last === undefined ||
    last >= endOffset ||
    (next !== undefined && next < endOffset)
  ) {
    return null;
  }
  return text.slice(start, end) === needle ? { start, end } : null;
};

const placed = (
  { anchorId, compact: text }: Pick<IndexedPiece, "anchorId" | "compact">,
  span: CompactSpan,
): ReaderTextQuotePlacement => ({
  status: "placed",
  blockAnchorId: anchorId,
  ...rawSpanOf(text, span),
});

/** Places stored marks in one version of a document's text. */
export type ReaderTextQuoteLocator = (
  selector: ReaderTextQuoteSelector,
) => ReaderTextQuotePlacement;

/**
 * A locator over the document's anchored pieces, in reading order.
 *
 * A re-parse re-segments a text: it moves where blocks start and end, and
 * with them anchors and offsets, but it does not change the words or their
 * order. Read as one run with the whitespace dropped, the text around a
 * passage is therefore the same before and after, across whatever block
 * boundary now falls inside its context. So a candidate is an occurrence of
 * the quote inside one block whose surroundings in that run agree with the
 * whole stored context, and the mark is placed only on such a candidate:
 *
 * - at its stored position, when that is one, which settles every mark on a
 *   text nobody re-parsed by reading one block;
 * - at the only candidate, when there is one;
 * - nowhere otherwise: no candidate means the words or the text around them
 *   changed, several mean nothing the mark holds tells them apart.
 *
 * Context is what tells repeated wording apart, so a mark made without one
 * (an empty prefix and suffix) is placed by its stored position and its
 * words alone, and two passages identical in their words and their whole
 * context cannot be told apart by anything a mark holds.
 */
export const createReaderTextQuoteLocator = (
  pieces: readonly ReaderTextPiece[],
): ReaderTextQuoteLocator => {
  // Compacted on first use: a text nobody re-parsed reads only the blocks
  // its marks name.
  let indexed: { pieces: IndexedPiece[]; stream: string } | null = null;
  const index = () => {
    if (indexed !== null) {
      return indexed;
    }
    let stream = "";
    const indexedPieces = pieces.map(({ anchorId, text }) => {
      const piece = {
        anchorId,
        compact: compact(text),
        streamStart: stream.length,
      };
      stream += piece.compact.text;
      return piece;
    });
    indexed = { pieces: indexedPieces, stream };
    return indexed;
  };
  const byAnchor = new Map<string, ReaderTextPiece>();
  for (const piece of pieces) {
    if (!byAnchor.has(piece.anchorId)) {
      byAnchor.set(piece.anchorId, piece);
    }
  }

  /** Whether the stored context agrees with the run around a span. */
  const agreesInStream = (
    stream: string,
    at: number,
    { needle, prefix, suffix }: StoredQuote,
  ): boolean =>
    contextAgrees(
      prefix,
      stream.slice(Math.max(0, at - prefix.length), at),
      "before",
    ) &&
    contextAgrees(
      suffix,
      stream.slice(at + needle.length, at + needle.length + suffix.length),
      "after",
    );

  /**
   * The stored position, when it holds the quote and its own block holds
   * the whole stored context around it: the document run there is that
   * block's text, so no other block need be read.
   */
  const inPlace = (
    selector: ReaderTextQuoteSelector,
    quote: StoredQuote,
  ): ReaderTextQuotePlacement | null => {
    const raw = byAnchor.get(selector.blockAnchorId);
    if (raw === undefined) {
      return null;
    }
    const piece = { anchorId: raw.anchorId, compact: compact(raw.text) };
    const span = storedSpanIn(piece.compact, selector, quote.needle);
    if (
      span === null ||
      span.start < quote.prefix.length ||
      piece.compact.text.length - span.end < quote.suffix.length ||
      !agreesInStream(piece.compact.text, span.start, quote)
    ) {
      return null;
    }
    return placed(piece, span);
  };

  return (selector) => {
    const quote: StoredQuote = {
      needle: compactText(selector.quote),
      prefix: compactText(selector.quotePrefix),
      suffix: compactText(selector.quoteSuffix),
    };
    if (quote.needle.length === 0) {
      return { status: "orphaned", reason: "quote_not_found" };
    }
    const stayed = inPlace(selector, quote);
    if (stayed !== null) {
      return stayed;
    }

    const { pieces: indexedPieces, stream } = index();
    const candidates: { piece: IndexedPiece; span: CompactSpan }[] = [];
    for (const piece of indexedPieces) {
      for (const start of compactOccurrences(
        piece.compact.text,
        quote.needle,
      )) {
        if (agreesInStream(stream, piece.streamStart + start, quote)) {
          candidates.push({
            piece,
            span: { start, end: start + quote.needle.length },
          });
        }
      }
    }
    const atStoredPosition = candidates.find(
      ({ piece, span }) =>
        piece.anchorId === selector.blockAnchorId &&
        rawSpanOf(piece.compact, span).startOffset === selector.startOffset,
    );
    if (atStoredPosition !== undefined) {
      return placed(atStoredPosition.piece, atStoredPosition.span);
    }
    const [only, ...others] = candidates;
    if (only === undefined) {
      return { status: "orphaned", reason: "quote_not_found" };
    }
    return others.length === 0
      ? placed(only.piece, only.span)
      : { status: "orphaned", reason: "quote_ambiguous" };
  };
};

type PlacedReaderMarks<T extends ReaderTextQuoteSelector> = {
  /** The marks with a place in this text, at that place. */
  placed: T[];
  /** The marks without one, unchanged, with the reason. */
  orphaned: { mark: T; reason: ReaderTextQuoteOrphanReason }[];
};

/**
 * Every mark placed in the current text or set aside as orphaned. A placed
 * mark carries its current anchor and offsets; its stored ones may name
 * other words now and are not passed on.
 */
export const placeReaderMarks = <T extends ReaderTextQuoteSelector>(
  marks: readonly T[],
  pieces: readonly ReaderTextPiece[],
): PlacedReaderMarks<T> => {
  const locate = createReaderTextQuoteLocator(pieces);
  const result: PlacedReaderMarks<T> = { placed: [], orphaned: [] };
  for (const mark of marks) {
    const placement = locate(mark);
    switch (placement.status) {
      case "placed":
        result.placed.push({
          ...mark,
          blockAnchorId: placement.blockAnchorId,
          startOffset: placement.startOffset,
          endOffset: placement.endOffset,
        });
        break;
      case "orphaned":
        result.orphaned.push({ mark, reason: placement.reason });
        break;
      default:
        placement satisfies never;
        return panic("Unhandled reader mark placement");
    }
  }
  return result;
};

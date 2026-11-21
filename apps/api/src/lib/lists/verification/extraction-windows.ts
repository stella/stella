/**
 * How claim extraction cuts the text a run reads into model calls.
 *
 * A call's time follows the text it reads: the model quotes every claim word
 * for word, so its answer grows with its input. Windows are therefore sized
 * by text, never by block count; a PDF page is one block, and forty pages
 * in one call ran past the call deadline. A block longer than a window (a
 * dense page, a long paragraph) is split into pieces at the best boundary
 * the text offers: a blank line, then a sentence that ends a line, then any
 * sentence end, then a line break, then a space. A piece keeps its offsets in
 * the whole block, so a claim found in it anchors where the reader shows it.
 *
 * Budgets are in the one token estimate (`estimateTextTokens`), applied to
 * the exact lines a call sends.
 */

import { panic } from "better-result";

import {
  BYTES_PER_TOKEN_ESTIMATE,
  estimateTextTokens,
} from "@/api/lib/ai-generation/token-estimate";
import type { VerificationPassage } from "@/api/lib/lists/verification/paragraph-scope";

/**
 * The text one extraction call is asked about, in estimated tokens.
 *
 * Measured on Opus: an extraction call answers about 150 output tokens a
 * second and writes up to about 1.6 output tokens per input token (it
 * quotes). This budget is about 2,300 real tokens of English, so a dense
 * window answers in about 25 s and a slow one in under 60 s, half the call
 * deadline, with the context and system prompt on top.
 */
export const EXTRACTION_WINDOW_TOKENS = 3000;
/** Text shown on each side of a window, so a claim that starts or ends
 *  just outside it still reads as one. */
export const EXTRACTION_CONTEXT_TOKENS = 500;

const WINDOW_BYTES = EXTRACTION_WINDOW_TOKENS * BYTES_PER_TOKEN_ESTIMATE;
const CONTEXT_BYTES = EXTRACTION_CONTEXT_TOKENS * BYTES_PER_TOKEN_ESTIMATE;

/** One piece of a passage, read under its own id. */
export type ExtractionPiece = {
  /** The id the model cites: the block's own id when the block is read
   *  whole, else the block's id and the piece's number. */
  id: string;
  /** Index of the passage this piece is cut from. */
  passageIndex: number;
  /** Offsets into the block's whole text. */
  start: number;
  end: number;
  text: string;
};

/** A run of consecutive pieces one call is asked about: `[from, to)`. */
export type ExtractionWindow = { from: number; to: number };

const byteLength = (text: string): number => Buffer.byteLength(text);

/** The line a piece is sent as; `blocksText` writes the same shape. */
export const pieceLine = (id: string, text: string): string =>
  `[${id}] ${text}`;

/** Every window's lines, as the call sends them. */
export const windowText = (pieces: readonly ExtractionPiece[]): string =>
  pieces.map((piece) => pieceLine(piece.id, piece.text)).join("\n");

/** Whether a surrogate pair starts at `index`: cutting after it would
 *  split one character in two. */
const opensPair = (text: string, index: number): boolean =>
  (text.codePointAt(index) ?? 0) > 0xff_ff;

/** The furthest end after `from` whose slice fits `bytes`, never inside a
 *  surrogate pair. */
const furthestFit = (text: string, from: number, bytes: number): number => {
  let lo = from;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(from, mid)) <= bytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo < text.length && lo > from && opensPair(text, lo - 1)) {
    lo -= 1;
  }
  return lo;
};

/** The nearest start before `to` whose slice fits `bytes`. */
const nearestFit = (text: string, to: number, bytes: number): number => {
  let lo = 0;
  let hi = to;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byteLength(text.slice(mid, to)) <= bytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  if (lo > 0 && lo < to && opensPair(text, lo - 1)) {
    lo += 1;
  }
  return lo;
};

/** Boundaries to cut after, best first. Each match ends where the next
 *  piece starts. */
const CUT_BOUNDARIES: readonly RegExp[] = [
  /\n[^\S\n]*\n\s*/gu,
  /[.!?;:]["'”’)\]]*[^\S\n]*\n\s*/gu,
  /[.!?]["'”’)\]]*\s+/gu,
  /\n\s*/gu,
  /\s+/gu,
];

/**
 * Where to end a piece that starts at `from` and may run to `limit`: after
 * the best boundary in the second half of that span, so no piece is cut
 * much shorter than it may be; at `limit` when the span has none.
 */
const cutPoint = (text: string, from: number, limit: number): number => {
  const floor = from + Math.floor((limit - from) / 2);
  const span = text.slice(floor, limit);
  for (const boundary of CUT_BOUNDARIES) {
    let last: number | null = null;
    for (const match of span.matchAll(boundary)) {
      const end = floor + match.index + match[0].length;
      if (end > from && end <= limit) {
        last = end;
      }
    }
    if (last !== null) {
      return last;
    }
  }
  return limit;
};

/**
 * Cut `[start, end)` of `text` into spans of at most `bytes` each, at the
 * best boundaries. The spans are contiguous and cover the range exactly.
 */
export const splitText = (
  text: string,
  start: number,
  end: number,
  bytes: number,
): { start: number; end: number }[] => {
  if (bytes < 4) {
    return panic("A piece must fit at least one character");
  }
  const spans: { start: number; end: number }[] = [];
  let from = start;
  while (byteLength(text.slice(from, end)) > bytes) {
    const limit = Math.min(end, furthestFit(text, from, bytes));
    if (limit <= from) {
      return panic("A piece must make progress");
    }
    const cut = cutPoint(text, from, limit);
    spans.push({ start: from, end: cut });
    from = cut;
  }
  spans.push({ start: from, end });
  return spans;
};

/** Room left for a piece's text once its line's id prefix is counted. The
 *  prefix is sized for the longest id a split can give. */
const pieceTextBytes = (blockId: string): number =>
  WINDOW_BYTES - byteLength(pieceLine(`${blockId}~000000`, ""));

/**
 * The pieces a run reads, in reading order. A passage that fits a window is
 * one piece under its block's id; a longer one is cut, each piece under its
 * block's id and its number from 1 (`P12~1`, `P12~2`). An id another block
 * already holds is never reused.
 */
export const extractionPieces = (
  passages: readonly VerificationPassage[],
): ExtractionPiece[] => {
  const taken = new Set(passages.map(({ block }) => block.id));
  return passages.flatMap(({ block, start, end }, passageIndex) => {
    const spans = splitText(block.text, start, end, pieceTextBytes(block.id));
    if (spans.length === 1) {
      return [
        {
          id: block.id,
          passageIndex,
          start,
          end,
          text: block.text.slice(start, end),
        },
      ];
    }
    return spans.map((span, index) => {
      let id = `${block.id}~${String(index + 1)}`;
      while (taken.has(id)) {
        id = `${id}~`;
      }
      taken.add(id);
      return {
        id,
        passageIndex,
        start: span.start,
        end: span.end,
        text: block.text.slice(span.start, span.end),
      };
    });
  });
};

/**
 * Consecutive pieces packed into windows, each window's lines within the
 * window budget. A piece is never larger than a window, so every piece is
 * in exactly one window.
 */
export const extractionWindows = (
  pieces: readonly ExtractionPiece[],
): ExtractionWindow[] => {
  const windows: ExtractionWindow[] = [];
  let from = 0;
  let bytes = 0;
  for (const [index, piece] of pieces.entries()) {
    const line = byteLength(pieceLine(piece.id, piece.text));
    const joined = index === from ? line : bytes + 1 + line;
    if (index > from && joined > WINDOW_BYTES) {
      windows.push({ from, to: index });
      from = index;
      bytes = line;
    } else {
      bytes = joined;
    }
  }
  if (from < pieces.length) {
    windows.push({ from, to: pieces.length });
  }
  return windows;
};

/** Whether a window's lines fit the window budget. */
export const windowFits = (pieces: readonly ExtractionPiece[]): boolean =>
  estimateTextTokens(windowText(pieces)) <= EXTRACTION_WINDOW_TOKENS;

/**
 * The pieces shown around a window: whole neighbours while they fit the
 * context budget on their side, and the nearest part of the first one that
 * does not. A context piece keeps its id, so a claim quoted from it still
 * grounds in its own text.
 */
export const windowContext = (
  pieces: readonly ExtractionPiece[],
  { from, to }: ExtractionWindow,
): { before: ExtractionPiece[]; after: ExtractionPiece[] } => {
  const before: ExtractionPiece[] = [];
  let room = CONTEXT_BYTES;
  for (let index = from - 1; index >= 0 && room > 0; index -= 1) {
    const piece = pieces[index] ?? panic("A context piece is in range");
    const line = byteLength(pieceLine(piece.id, piece.text)) + 1;
    if (line <= room) {
      before.unshift(piece);
      room -= line;
      continue;
    }
    const tail = nearestFit(
      piece.text,
      piece.text.length,
      room - byteLength(pieceLine(piece.id, "")) - 1,
    );
    if (tail < piece.text.length) {
      before.unshift({ ...piece, text: piece.text.slice(tail) });
    }
    break;
  }
  const after: ExtractionPiece[] = [];
  room = CONTEXT_BYTES;
  for (let index = to; index < pieces.length && room > 0; index += 1) {
    const piece = pieces[index] ?? panic("A context piece is in range");
    const line = byteLength(pieceLine(piece.id, piece.text)) + 1;
    if (line <= room) {
      after.push(piece);
      room -= line;
      continue;
    }
    const roomForText = room - byteLength(pieceLine(piece.id, "")) - 1;
    const head = roomForText < 4 ? 0 : furthestFit(piece.text, 0, roomForText);
    if (head > 0) {
      after.push({ ...piece, text: piece.text.slice(0, head) });
    }
    break;
  }
  return { before, after };
};

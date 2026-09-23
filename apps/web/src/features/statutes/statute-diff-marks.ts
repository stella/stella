import { panic } from "better-result";

import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import type { Block } from "@stll/legal-ast/document-ast";

import { buildDocumentAstSearchPieces } from "@/components/legal-reader/document-ast-text";
import type { ReaderMarkRange } from "@/components/legal-reader/reader-search";

type SurroundedText = { leading: string; core: string; trailing: string };

/**
 * The visible part of a changed run and the whitespace around it. A run often
 * carries the space or line break that joins it to its neighbour; marking
 * that draws an empty box (after a heading that gained a title, say), so only
 * the visible text is marked and the whitespace keeps its place unmarked.
 */
export const splitSurroundingWhitespace = (text: string): SurroundedText => {
  const rest = text.trimStart();
  const core = rest.trimEnd();

  return {
    leading: text.slice(0, text.length - rest.length),
    core,
    trailing: rest.slice(core.length),
  };
};

/**
 * The marks a word diff draws, as offsets into its segments joined: one side
 * of a comparison, or both wordings inline. A deletion is marked deleted and
 * an insertion inserted; a change of whitespace alone has nothing visible to
 * mark.
 */
export const diffMarkRanges = (
  segments: readonly WordDiffSegment[],
): ReaderMarkRange[] => {
  const ranges: ReaderMarkRange[] = [];
  let offset = 0;

  for (const segment of segments) {
    const { core, leading } = splitSurroundingWhitespace(segment.text);
    const start = offset + leading.length;
    offset += segment.text.length;

    if (segment.type === "equal" || core === "") {
      continue;
    }

    ranges.push({
      type: segment.type === "del" ? "deleted" : "inserted",
      start,
      end: start + core.length,
    });
  }

  return ranges;
};

/** Whether one side of a diff marks anything a reader can see. */
export const hasVisibleChange = (
  segments: readonly WordDiffSegment[],
): boolean => diffMarkRanges(segments).length > 0;

const WHITESPACE_RUN = /\s+/gu;

const visibleWords = (text: string): string =>
  text.replace(WHITESPACE_RUN, " ").trim();

/**
 * A deletion next to an insertion of the same words, spaced differently: a
 * doubled space, a non-breaking one, a line break where a space was.
 */
export const isWhitespaceReplacement = (
  first: WordDiffSegment,
  second: WordDiffSegment,
): boolean =>
  ((first.type === "del" && second.type === "ins") ||
    (first.type === "ins" && second.type === "del")) &&
  visibleWords(first.text) === visibleWords(second.text);

/**
 * A stretch of a block's text the reader renders as one piece; `id` is null
 * for text the reader shows no characters of (an image's address).
 */
type ComparePiece = { id: string | null; text: string };

/**
 * The pieces a block is compared by, in the order the reader writes them.
 * They are the reader's own search pieces, so an offset into one is an offset
 * the renderer walks: comparing `block.plainText` instead would drift, since
 * it is trimmed and collapsed for search.
 */
const comparePieces = (block: Block): ComparePiece[] =>
  block.type === "image"
    ? [{ id: null, text: block.src }]
    : buildDocumentAstSearchPieces([block]);

/** Pieces are joined by a line break, which is never itself marked. */
const PIECE_SEPARATOR = "\n";

/**
 * The text blocks are compared by: every piece of every block, joined. One
 * block or several (a paragraph split in two), the axis is the same.
 */
export const compareText = (blocks: readonly Block[]): string =>
  blocks
    .flatMap(comparePieces)
    .map((piece) => piece.text)
    .join(PIECE_SEPARATOR);

/**
 * One side of a compared row: the consolidation's blocks, and the word diff
 * read from that side. The segments joined are the blocks' compare texts
 * joined by `PIECE_SEPARATOR`.
 */
export type StatuteCompareSide = {
  blocks: readonly Block[];
  segments: readonly WordDiffSegment[];
};

/** A block to render, with the diff marks that fall in each of its pieces. */
type MarkedBlock = {
  block: Block;
  rangesByPieceId: Record<string, ReaderMarkRange[]>;
};

/**
 * Each block of a side with its marks, cut to the pieces they fall in and
 * shifted to offsets within each piece: the shape the reader's renderer
 * highlights by.
 */
export const markSide = ({
  blocks,
  segments,
}: StatuteCompareSide): MarkedBlock[] => {
  if (
    segments.map((segment) => segment.text).join("") !== compareText(blocks)
  ) {
    return panic("A compared side's diff does not spell its blocks' text");
  }

  const ranges = diffMarkRanges(segments);
  const marked: MarkedBlock[] = [];
  let pieceStart = 0;

  for (const block of blocks) {
    const rangesByPieceId: Record<string, ReaderMarkRange[]> = {};

    for (const piece of comparePieces(block)) {
      const pieceEnd = pieceStart + piece.text.length;

      if (piece.id !== null) {
        const inPiece: ReaderMarkRange[] = [];
        for (const range of ranges) {
          const start = Math.max(range.start, pieceStart);
          const end = Math.min(range.end, pieceEnd);
          if (start < end) {
            inPiece.push({
              ...range,
              start: start - pieceStart,
              end: end - pieceStart,
            });
          }
        }
        if (inPiece.length > 0) {
          rangesByPieceId[piece.id] = inPiece;
        }
      }
      pieceStart = pieceEnd + PIECE_SEPARATOR.length;
    }
    marked.push({ block, rangesByPieceId });
  }

  return marked;
};

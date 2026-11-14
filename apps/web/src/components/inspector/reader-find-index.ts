import { panic } from "better-result";

import {
  createReaderSearchIndex,
  searchReaderIndex,
} from "@stll/decision-reader/reader-search";
import type { ReaderSearchIndex } from "@stll/decision-reader/reader-search";

type TextNodeSegment = { node: Node; start: number; end: number };

/** One run of text a search reads as a whole: inline markup joined up. */
type DomTextPiece = {
  /** The paragraph-level element the run belongs to. */
  block: Element;
  nodes: TextNodeSegment[];
};

/**
 * A reader's text read once: the text nodes in document order, grouped into
 * the pieces a search matches within, and the folded word index over them.
 *
 * Built once per version of the text. A query is then a lookup in the index;
 * nothing walks the document again until the text changes.
 */
export type ReaderFindIndex = {
  readonly pieces: readonly DomTextPiece[];
  readonly root: HTMLElement;
  readonly search: ReaderSearchIndex;
};

/** One match, in document order, with the block it is drawn in. */
export type ReaderFindMatch = {
  readonly block: Element;
  readonly end: number;
  readonly piece: DomTextPiece;
  readonly start: number;
};

const SKIPPED_TEXT_SELECTOR =
  "[data-reader-chrome], [aria-hidden='true'], .sr-only, script, style";
const BLOCK_SELECTOR =
  "p, li, dt, dd, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, figcaption";

/** Inline markup shares a search piece; paragraph boundaries keep words apart. */
export const buildReaderFindIndex = (root: HTMLElement): ReaderFindIndex => {
  const pieces: DomTextPiece[] = [];
  const texts: { id: string; text: string }[] = [];
  const textRoot = root.matches('[data-slot="reader-document-column"]')
    ? root
    : (root.querySelector<HTMLElement>(
        '[data-slot="reader-document-column"]',
      ) ?? root);
  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  let previousBlock: Element | null = null;
  let piece: DomTextPiece | undefined;
  let pieceText = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (parent?.closest(SKIPPED_TEXT_SELECTOR)) {
      continue;
    }
    const text = node.textContent ?? "";
    if (text.length === 0) {
      continue;
    }
    const block = parent?.closest(BLOCK_SELECTOR) ?? textRoot;
    if (piece === undefined || block !== previousBlock) {
      if (piece !== undefined) {
        texts.push({ id: String(texts.length), text: pieceText });
      }
      piece = { block, nodes: [] };
      pieceText = "";
      pieces.push(piece);
      previousBlock = block;
    }
    piece.nodes.push({
      node,
      start: pieceText.length,
      end: pieceText.length + text.length,
    });
    pieceText += text;
  }
  if (piece !== undefined) {
    texts.push({ id: String(texts.length), text: pieceText });
  }
  return { pieces, root, search: createReaderSearchIndex(texts) };
};

/** Every match of the query, in document order. */
export const findReaderMatches = (
  index: ReaderFindIndex,
  query: string,
): ReaderFindMatch[] => {
  const results = searchReaderIndex(index.search, query);
  const matches: ReaderFindMatch[] = [];
  for (const [pieceIndex, piece] of index.pieces.entries()) {
    const pieceMatches = results.rangesByPieceId[String(pieceIndex)];
    if (pieceMatches === undefined) {
      continue;
    }
    for (const match of pieceMatches) {
      matches.push({
        block: piece.block,
        end: match.end,
        piece,
        start: match.start,
      });
    }
  }
  return matches;
};

/** The DOM range a match covers, made when it is drawn rather than per query. */
export const rangeOfMatch = (match: ReaderFindMatch): Range => {
  const start = match.piece.nodes.find(
    (segment) => match.start >= segment.start && match.start < segment.end,
  );
  const end = match.piece.nodes.find(
    (segment) => match.end > segment.start && match.end <= segment.end,
  );
  if (start === undefined || end === undefined) {
    panic("Reader search match must map to its source text nodes");
  }
  const range = document.createRange();
  range.setStart(start.node, match.start - start.start);
  range.setEnd(end.node, match.end - end.start);
  return range;
};

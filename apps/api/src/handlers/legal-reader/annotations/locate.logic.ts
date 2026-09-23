/**
 * Places an agent's mark on a legal document's text.
 *
 * A reader selects words and the browser measures them; an agent can only
 * name a passage by the anchor the document text shows it and the words it
 * read there. This turns that pair into the span the reader would have
 * stored: offsets into the block's raw text (`plainTextOf`, the axis the
 * reader renders and anchors by) and the quote as that text spells it.
 */

import { panic } from "better-result";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import { plainTextOf, tableCellPieceId } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";

export type AnnotationPassage = {
  /** The block anchor the document text prints in square brackets. */
  anchor: string;
  /** The words to mark, as they read in that block. */
  quote: string;
};

export type LocatedSpan = {
  blockAnchorId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
};

export const ANNOTATION_LOCATE_ISSUE = {
  anchorNotFound: "anchor_not_found",
  blockHasNoText: "block_has_no_text",
  quoteAmbiguous: "quote_ambiguous",
  quoteNotFound: "quote_not_found",
  quoteTooLong: "quote_too_long",
} as const;

export type AnnotationLocateIssueCode =
  (typeof ANNOTATION_LOCATE_ISSUE)[keyof typeof ANNOTATION_LOCATE_ISSUE];

export type AnnotationLocateIssue = {
  code: AnnotationLocateIssueCode;
  /** Index into the passages the caller sent. */
  passageIndex: number;
  message: string;
};

export type LocatePassagesResult =
  | { status: "located"; spans: LocatedSpan[] }
  | { status: "rejected"; issues: AnnotationLocateIssue[] };

type NormalizedText = {
  text: string;
  /** Raw index of every normalized character. */
  rawIndex: number[];
};

const WHITESPACE = /\s/u;

/**
 * Every whitespace run as one space, so a quote a model re-typed with a
 * plain space still finds text the source set with a non-breaking one or a
 * line break. The map keeps the offsets on the raw axis.
 */
const normalizeWhitespace = (raw: string): NormalizedText => {
  let text = "";
  const rawIndex: number[] = [];
  let previousWasSpace = false;
  for (const [index, char] of [...raw].entries()) {
    const isSpace = WHITESPACE.test(char);
    if (isSpace && previousWasSpace) {
      continue;
    }
    text += isSpace ? " " : char;
    rawIndex.push(index);
    previousWasSpace = isSpace;
  }
  return { text, rawIndex };
};

type Occurrence = { startOffset: number; endOffset: number };

/**
 * Offsets are UTF-16 indices, the unit a browser selection measures, so the
 * raw index above (a code-point index) is converted back before it is stored.
 */
const codePointToUtf16Offsets = (raw: string): number[] => {
  const offsets: number[] = [];
  let utf16 = 0;
  for (const char of raw) {
    offsets.push(utf16);
    utf16 += char.length;
  }
  offsets.push(utf16);
  return offsets;
};

const findOccurrences = (raw: string, quote: string): Occurrence[] => {
  const haystack = normalizeWhitespace(raw);
  const needle = normalizeWhitespace(quote.trim()).text;
  if (needle.length === 0) {
    return [];
  }
  const utf16 = codePointToUtf16Offsets(raw);
  const occurrences: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.text.indexOf(needle, from);
    if (at === -1) {
      return occurrences;
    }
    const start = haystack.rawIndex[at];
    const last = haystack.rawIndex[at + needle.length - 1];
    if (start === undefined || last === undefined) {
      return occurrences;
    }
    const startOffset = utf16[start];
    const endOffset = utf16[last + 1];
    if (startOffset !== undefined && endOffset !== undefined) {
      occurrences.push({ startOffset, endOffset });
    }
    from = at + 1;
  }
};

/** The places a block's words are rendered, each under its own anchor. */
type TextPiece = { anchorId: string; text: string };

const piecesOf = (block: Block): TextPiece[] => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [{ anchorId: block.anchorId, text: plainTextOf(block.inlines) }];
    case "table":
      return block.rows.flatMap((row, rowIndex) =>
        row.map((cell, columnIndex) => ({
          anchorId: tableCellPieceId({
            blockId: block.id,
            columnIndex,
            rowIndex,
          }),
          text: plainTextOf(cell.inlines),
        })),
      );
    case "image":
      return [];
    default:
      block satisfies never;
      return panic(`Unhandled block type: ${String(block)}`);
  }
};

type PieceMatch = { piece: TextPiece; occurrence: Occurrence };

type LocateOneResult =
  | { type: "span"; span: LocatedSpan }
  | { type: "issue"; issue: AnnotationLocateIssue };

const issue = (value: AnnotationLocateIssue): LocateOneResult => ({
  type: "issue",
  issue: value,
});

const locateOne = (
  blocksByAnchor: ReadonlyMap<string, Block>,
  { anchor, quote }: AnnotationPassage,
  passageIndex: number,
): LocateOneResult => {
  const block = blocksByAnchor.get(anchor);
  if (block === undefined) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.anchorNotFound,
      passageIndex,
      message: /^\[.*\]$/u.test(anchor)
        ? `No block is anchored "${anchor}". Pass the anchor without its square brackets.`
        : `No block is anchored "${anchor}" in this document. Use an anchor the document text prints in square brackets.`,
    });
  }
  const pieces = piecesOf(block);
  if (pieces.length === 0) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.blockHasNoText,
      passageIndex,
      message: `Block "${anchor}" is an image and has no text to mark.`,
    });
  }
  const matches: PieceMatch[] = pieces.flatMap((piece) =>
    findOccurrences(piece.text, quote).map((occurrence) => ({
      occurrence,
      piece,
    })),
  );
  const [match, ...others] = matches;
  if (match === undefined) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteNotFound,
      passageIndex,
      message:
        block.type === "table"
          ? `The quote is not in any one cell of table "${anchor}". Quote words from a single cell, or send one passage per cell.`
          : `The quote is not in block "${anchor}". Copy the words exactly as that block reads; a passage over several paragraphs is one passage per paragraph.`,
    });
  }
  if (others.length > 0) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteAmbiguous,
      passageIndex,
      message: `The quote occurs ${String(matches.length)} times in block "${anchor}". Quote more of the surrounding words so it occurs once.`,
    });
  }
  const { occurrence, piece } = match;
  const stored = piece.text.slice(occurrence.startOffset, occurrence.endOffset);
  if (stored.length > READER_ANNOTATION_QUOTE_MAX_LENGTH) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteTooLong,
      passageIndex,
      message: `The passage in block "${anchor}" runs to ${String(stored.length)} characters; a mark holds at most ${String(READER_ANNOTATION_QUOTE_MAX_LENGTH)}. Mark a shorter passage.`,
    });
  }
  return {
    type: "span",
    span: {
      blockAnchorId: piece.anchorId,
      startOffset: occurrence.startOffset,
      endOffset: occurrence.endOffset,
      quote: stored,
    },
  };
};

/**
 * Every passage located, or every passage that could not be: the passages
 * are one mark, so none is stored unless all of them are placed, and the
 * caller hears about each failure at once rather than one per retry.
 */
export const locatePassages = (
  blocks: readonly Block[],
  passages: readonly AnnotationPassage[],
): LocatePassagesResult => {
  const blocksByAnchor = new Map(
    blocks.map((block) => [block.anchorId, block] as const),
  );
  const spans: LocatedSpan[] = [];
  const issues: AnnotationLocateIssue[] = [];
  for (const [index, passage] of passages.entries()) {
    const located = locateOne(blocksByAnchor, passage, index);
    switch (located.type) {
      case "span":
        spans.push(located.span);
        break;
      case "issue":
        issues.push(located.issue);
        break;
      default:
        located satisfies never;
        return panic("Unhandled passage location");
    }
  }
  return issues.length > 0
    ? { status: "rejected", issues }
    : { status: "located", spans };
};

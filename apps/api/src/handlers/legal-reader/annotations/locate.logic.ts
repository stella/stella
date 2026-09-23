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
  /**
   * The block anchor the document text prints in square brackets. Absent,
   * the whole document is searched and the quote must occur once in it.
   */
  anchor?: string | undefined;
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

type CompactText = {
  text: string;
  /** UTF-16 offset in the raw text of every compact code unit. */
  rawIndex: number[];
};

const WHITESPACE = /\s/u;

/**
 * The text with every whitespace character dropped, one entry per UTF-16
 * code unit (the unit a browser selection measures, and the unit `indexOf`
 * returns). Matching here finds a quote however its spaces were typed: a
 * plain space for a non-breaking one or a line break, and the collapsed
 * form of a letter-spaced heading ("R O Z S U D E K" as "ROZSUDEK"), which
 * is how the agent-facing text prints it. Every whitespace character is in
 * the BMP, so dropping one never splits a surrogate pair.
 */
const compact = (raw: string): CompactText => {
  let text = "";
  const rawIndex: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const unit = raw.charAt(index);
    if (WHITESPACE.test(unit)) {
      continue;
    }
    text += unit;
    rawIndex.push(index);
  }
  return { text, rawIndex };
};

type Occurrence = { startOffset: number; endOffset: number };

const findOccurrences = (raw: string, quote: string): Occurrence[] => {
  const haystack = compact(raw);
  const needle = compact(quote).text;
  if (needle.length === 0) {
    return [];
  }
  const occurrences: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.text.indexOf(needle, from);
    if (at === -1) {
      return occurrences;
    }
    const startOffset = haystack.rawIndex[at];
    const last = haystack.rawIndex[at + needle.length - 1];
    if (startOffset === undefined || last === undefined) {
      return panic("A compact match lies outside its own text");
    }
    occurrences.push({ startOffset, endOffset: last + 1 });
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

type LocateContext = {
  blocks: readonly Block[];
  blocksByAnchor: ReadonlyMap<string, Block>;
};

type LocateOneResult =
  | { type: "span"; span: LocatedSpan }
  | { type: "issue"; issue: AnnotationLocateIssue };

const issue = (value: AnnotationLocateIssue): LocateOneResult => ({
  type: "issue",
  issue: value,
});

const quoteNotFoundMessage = (block: Block | undefined): string => {
  if (block === undefined) {
    return "The quote does not occur in this document. Copy the words exactly as the document reads them; a passage over several paragraphs is one passage per paragraph.";
  }
  return block.type === "table"
    ? `The quote is not in any one cell of table "${block.anchorId}". Quote words from a single cell, or send one passage per cell.`
    : `The quote is not in block "${block.anchorId}". Copy the words exactly as that block reads; a passage over several paragraphs is one passage per paragraph.`;
};

/** How many candidate anchors an ambiguity issue names. */
const AMBIGUITY_ANCHORS_SHOWN = 8;

const matchesIn = (blocks: readonly Block[], quote: string) =>
  blocks.flatMap((block) =>
    piecesOf(block).flatMap((piece) =>
      findOccurrences(piece.text, quote).map((occurrence) => ({
        block,
        occurrence,
        piece,
      })),
    ),
  );

const locateOne = (
  { blocks, blocksByAnchor }: LocateContext,
  { anchor, quote }: AnnotationPassage,
  passageIndex: number,
): LocateOneResult => {
  const block = anchor === undefined ? undefined : blocksByAnchor.get(anchor);
  if (anchor !== undefined && block === undefined) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.anchorNotFound,
      passageIndex,
      message: /^\[.*\]$/u.test(anchor)
        ? `No block is anchored "${anchor}". Pass the anchor without its square brackets.`
        : `No block is anchored "${anchor}" in this document. Use an anchor the document text prints in square brackets, or omit the anchor to search the whole document.`,
    });
  }
  if (block?.type === "image") {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.blockHasNoText,
      passageIndex,
      message: `Block "${block.anchorId}" is an image and has no text to mark.`,
    });
  }
  const matches = matchesIn(block === undefined ? blocks : [block], quote);
  const [match, ...others] = matches;
  if (match === undefined) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteNotFound,
      passageIndex,
      message: quoteNotFoundMessage(block),
    });
  }
  if (others.length > 0) {
    const anchors = [
      ...new Set(matches.map((candidate) => candidate.block.anchorId)),
    ];
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteAmbiguous,
      passageIndex,
      message:
        anchors.length > 1
          ? `The quote occurs ${String(matches.length)} times, in blocks ${anchors
              .slice(0, AMBIGUITY_ANCHORS_SHOWN)
              .map((candidate) => `"${candidate}"`)
              .join(
                ", ",
              )}${anchors.length > AMBIGUITY_ANCHORS_SHOWN ? " and more" : ""}. Pass the anchor of the one to mark, or quote more of the surrounding words.`
          : `The quote occurs ${String(matches.length)} times in block "${match.block.anchorId}". Quote more of the surrounding words so it occurs once.`,
    });
  }
  const { occurrence, piece } = match;
  const stored = piece.text.slice(occurrence.startOffset, occurrence.endOffset);
  if (stored.length > READER_ANNOTATION_QUOTE_MAX_LENGTH) {
    return issue({
      code: ANNOTATION_LOCATE_ISSUE.quoteTooLong,
      passageIndex,
      message: `The passage in block "${match.block.anchorId}" runs to ${String(stored.length)} characters; a mark holds at most ${String(READER_ANNOTATION_QUOTE_MAX_LENGTH)}. Mark a shorter passage.`,
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
  const context: LocateContext = {
    blocks,
    blocksByAnchor: new Map(
      blocks.map((block) => [block.anchorId, block] as const),
    ),
  };
  const spans: LocatedSpan[] = [];
  const issues: AnnotationLocateIssue[] = [];
  for (const [index, passage] of passages.entries()) {
    const located = locateOne(context, passage, index);
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

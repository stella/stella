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
import { readerAnchorPiecesOf } from "@stll/legal-ast/case-law-reader";
import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";
import {
  readerTextQuoteContext,
  readerTextQuoteOccurrences,
} from "@stll/legal-ast/reader-text-quote";

import { servedParagraphQuoteOf } from "@/api/lib/case-law/served-paragraph-number";

type AnnotationPassage = {
  /**
   * The block anchor the document text prints in square brackets. Absent,
   * the whole document is searched and the quote must occur once in it.
   */
  anchor?: string | undefined;
  /** The words to mark, as they read in that block. */
  quote: string;
};

type LocatedSpan = {
  blockAnchorId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  quotePrefix: string;
  quoteSuffix: string;
};

export const ANNOTATION_LOCATE_ISSUE = {
  anchorNotFound: "anchor_not_found",
  blockHasNoText: "block_has_no_text",
  quoteAmbiguous: "quote_ambiguous",
  quoteNotFound: "quote_not_found",
  quoteTooLong: "quote_too_long",
} as const;

type AnnotationLocateIssueCode =
  (typeof ANNOTATION_LOCATE_ISSUE)[keyof typeof ANNOTATION_LOCATE_ISSUE];

type AnnotationLocateIssue = {
  code: AnnotationLocateIssueCode;
  /** Index into the passages the caller sent. */
  passageIndex: number;
  message: string;
};

type LocatePassagesResult =
  | { status: "located"; spans: LocatedSpan[] }
  | { status: "rejected"; issues: AnnotationLocateIssue[] };

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

// Matched the way a stored mark is found again (`reader-text-quote`), so a
// mark an agent places is one the reader can place again after a re-parse.
const matchesIn = (blocks: readonly Block[], quote: string) =>
  blocks.flatMap((block) =>
    readerAnchorPiecesOf(block).flatMap((piece) =>
      readerTextQuoteOccurrences(piece.text, quote).map((occurrence) => ({
        block,
        occurrence,
        piece,
      })),
    ),
  );

/**
 * A quote copied with the court's paragraph number the served text prints
 * in front of a paragraph (`¶ 48 The applicant…`). The number is structure,
 * not the paragraph's text, so the words are matched at the start of the
 * paragraph the court numbered so.
 */
const servedParagraphMatches = (blocks: readonly Block[], rawQuote: string) => {
  const served = servedParagraphQuoteOf(rawQuote);
  if (served === null) {
    return [];
  }
  return matchesIn(
    blocks.filter((block) => courtParagraphNumber(block) === served.number),
    served.words,
  ).filter(
    ({ occurrence, piece }) =>
      piece.text.slice(0, occurrence.startOffset).trim() === "",
  );
};

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
  const candidates = block === undefined ? blocks : [block];
  const literal = matchesIn(candidates, quote);
  const matches =
    literal.length > 0 ? literal : servedParagraphMatches(candidates, quote);
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
  // Stored as Unicode scalar values: an isolated surrogate the database
  // cannot hold becomes U+FFFD, one UTF-16 unit, so offsets are unchanged.
  const stored = piece.text
    .slice(occurrence.startOffset, occurrence.endOffset)
    .toWellFormed();
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
      ...readerTextQuoteContext(piece.text, occurrence),
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

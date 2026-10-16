import { isValidElement } from "react";
import type { ReactNode } from "react";

import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";
import { hasBlockInlines, plainTextOf } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";
import { locateQuote } from "@stll/legal-ast/quote-locate";

/**
 * Where a quotation in an answer sits in a decision, when it sits there word
 * for word: the paragraph it starts in, by the anchor the reader renders and
 * the number the court printed.
 */
export type LocatedQuote = {
  anchorId: string;
  paragraph: number | null;
};

// An answer elides with "[…]", "[...]" or a bare "…"; each piece between
// elisions must be the court's words, in the court's order.
// Pieces are trimmed after the split, so the pattern needs no surrounding
// whitespace (which would make it backtrack super-linearly).
const ELISION = /\[\s*(?:…|\.\.\.)\s*\]|\(\s*(?:…|\.\.\.)\s*\)|…/u;

// The marks an answer wraps a quotation in, which the court's text lacks.
const WRAPPING_MARK = /[\s„“”"«»‚‘’']/u;

// A character scan instead of `^[…]+|[…]+$`, whose trailing alternative
// backtracks quadratically on a long run of marks. Every mark and space the
// pattern accepts is one UTF-16 unit, so a surrogate half never matches and
// the scan stops at it.
const trimWrappingMarks = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && WRAPPING_MARK.test(text.charAt(start))) {
    start += 1;
  }
  while (end > start && WRAPPING_MARK.test(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
};

/**
 * Shorter pieces prove nothing: "a to" or "podle § 237" occurs in many
 * decisions, so a quotation must carry at least one piece this long to count
 * as located at all.
 */
const MIN_EVIDENCE_LENGTH = 24;

// Markdown elements that start a new line of text. Inline elements
// (emphasis, links, code) join their neighbours directly, so formatting
// inside a word keeps the word whole.
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "ul",
]);

const textOfNode = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOfNode(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = textOfNode(node.props.children);
    return typeof node.type === "string" && BLOCK_ELEMENTS.has(node.type)
      ? ` ${inner} `
      : inner;
  }
  return "";
};

/** The displayed text of rendered Markdown children, blocks set apart by a space. */
export const quoteTextOf = (node: ReactNode): string =>
  textOfNode(node).replaceAll(/\s+/gu, " ").trim();

/** The quotation's own words, split at its elisions. */
export const quotePieces = (quote: string): string[] =>
  trimWrappingMarks(quote)
    .split(ELISION)
    .map((piece) => trimWrappingMarks(piece))
    .filter((piece) => piece.length > 0);

/**
 * The quotation's place in a decision, or null unless every piece of it is
 * the decision's text, in order. Matching tolerates only what a faithful copy
 * changes (quote marks, dashes, spacing; see `locateQuote`), so a located
 * quote is a verified one: any other difference is a misquote.
 */
export const locateQuoteInBlocks = (
  quote: string,
  blocks: readonly Block[],
): LocatedQuote | null => {
  const pieces = quotePieces(quote);
  if (!pieces.some((piece) => piece.length >= MIN_EVIDENCE_LENGTH)) {
    return null;
  }
  // The text blocks joined by line breaks, which matching reads as spacing,
  // so a quotation may run on from one paragraph into the next.
  const segments: { block: Block; start: number }[] = [];
  let text = "";
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    if (segments.length > 0) {
      text += "\n";
    }
    segments.push({ block, start: text.length });
    text += plainTextOf(block.inlines);
  }
  let from = 0;
  let firstStart: number | null = null;
  for (const piece of pieces) {
    const span = locateQuote(text, piece, from);
    // `locateQuote` only prefers an occurrence after `from` and falls back
    // to an earlier one; a piece before its predecessor is out of order.
    if (span === null || span.start < from) {
      return null;
    }
    firstStart ??= span.start;
    from = span.end;
  }
  const first =
    firstStart === null
      ? undefined
      : segments.findLast(({ start }) => start <= firstStart)?.block;
  return first === undefined
    ? null
    : { anchorId: first.anchorId, paragraph: courtParagraphNumber(first) };
};

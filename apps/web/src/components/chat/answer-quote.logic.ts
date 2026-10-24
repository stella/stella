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
  // Adjacent text blocks form runs. A non-text block ends a run, so its
  // omitted contents cannot be mistaken for contiguous source text.
  const runs: {
    segments: { block: Block; start: number }[];
    text: string;
  }[] = [];
  let run:
    | {
        segments: { block: Block; start: number }[];
        text: string;
      }
    | undefined;
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      run = undefined;
      continue;
    }
    if (run === undefined) {
      run = { segments: [], text: "" };
      runs.push(run);
    } else if (run.segments.length > 0) {
      run.text += "\n";
    }
    run.segments.push({ block, start: run.text.length });
    run.text += plainTextOf(block.inlines);
  }
  let runIndex = 0;
  let from = 0;
  let first: Block | undefined;
  for (const piece of pieces) {
    let match:
      { block: Block | undefined; end: number; runIndex: number } | undefined;
    for (const [offset, candidate] of runs.slice(runIndex).entries()) {
      const candidateIndex = runIndex + offset;
      const candidateFrom = candidateIndex === runIndex ? from : 0;
      const span = locateQuote(candidate.text, piece, candidateFrom);
      // `locateQuote` only prefers an occurrence after `from` and falls back
      // to an earlier one; a piece before its predecessor is out of order.
      if (span === null || span.start < candidateFrom) {
        continue;
      }
      match = {
        block: candidate.segments.findLast(({ start }) => start <= span.start)
          ?.block,
        end: span.end,
        runIndex: candidateIndex,
      };
      break;
    }
    if (match === undefined) {
      return null;
    }
    first ??= match.block;
    runIndex = match.runIndex;
    from = match.end;
  }
  return first === undefined
    ? null
    : { anchorId: first.anchorId, paragraph: courtParagraphNumber(first) };
};

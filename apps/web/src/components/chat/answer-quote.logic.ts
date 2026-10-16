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
  let blockIndex = 0;
  let from = 0;
  let first: Block | null = null;
  for (const piece of pieces) {
    let found = false;
    for (let index = blockIndex; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined || !hasBlockInlines(block)) {
        continue;
      }
      const sameBlock = index === blockIndex;
      const span = locateQuote(
        plainTextOf(block.inlines),
        piece,
        sameBlock ? from : 0,
      );
      // `locateQuote` only prefers an occurrence after `from` and falls back
      // to an earlier one; a piece before its predecessor is out of order.
      if (span === null || (sameBlock && span.start < from)) {
        continue;
      }
      first ??= block;
      blockIndex = index;
      from = span.end;
      found = true;
      break;
    }
    if (!found) {
      return null;
    }
  }
  return first === null
    ? null
    : { anchorId: first.anchorId, paragraph: courtParagraphNumber(first) };
};

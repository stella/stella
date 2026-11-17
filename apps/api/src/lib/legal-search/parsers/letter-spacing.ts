/**
 * A decision's blocks read through the letter-spacing owner,
 * `collapseLetterSpacing` in `@stll/text-normalize`, with the document's
 * own words as the evidence for uneven chunks. Parsers that read lines call
 * the owner directly; this is the entry point for those that build blocks.
 */

import type { Block, Inline } from "@stll/legal-ast/document-ast";
import { plainTextOf } from "@stll/legal-ast/document-ast";
import {
  mapInlineText,
  rewriteInlineWhitespace,
} from "@stll/legal-ast/inline-line";
import {
  collapseLetterSpacing,
  documentWordCounts,
} from "@stll/text-normalize";
import type { LetterSpacingOptions } from "@stll/text-normalize";

/**
 * A line's inlines read through the owner over the line's whole text: run
 * node by node, a wrapper's edge would read as the edge of the line, and a
 * spaced word set across two nodes or two printed lines would be judged in
 * pieces. Only whitespace changes; the inline tree is kept.
 */
export const readInlineLetterSpacing = (
  inlines: readonly Inline[],
  options?: LetterSpacingOptions,
): Inline[] =>
  rewriteInlineWhitespace(inlines, (text) =>
    collapseLetterSpacing(text, options),
  );

/**
 * A decision's blocks with every word the court spaced unevenly (`m ů že`)
 * read as the word it spells, when the decision prints that word intact
 * elsewhere. The entry point for parsers that build blocks rather than lines.
 */
export const withAttestedLetterSpacing = (
  blocks: readonly Block[],
): Block[] => {
  const documentWords = documentWordCounts(
    blocks.map(({ plainText }) => plainText),
  );
  return blocks.map((block): Block => {
    if (block.type !== "paragraph" && block.type !== "heading") {
      return block;
    }
    const inlines = mapInlineText(block.inlines, (text) =>
      collapseLetterSpacing(text, { documentWords }),
    );
    // The block's text is derived from its repaired inlines, never repaired
    // apart from them: a word split across formatting nodes stays as printed
    // in both. Only a changed reading replaces either.
    return plainTextOf(inlines) === plainTextOf(block.inlines)
      ? block
      : { ...block, inlines, plainText: plainTextOf(inlines).trim() };
  });
};

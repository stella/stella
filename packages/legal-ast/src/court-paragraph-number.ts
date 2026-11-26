// parser-output-unchanged: adds a reader-side summary of stored numbers; no parser calls it.
import type { Block } from "./document-ast.js";

/**
 * The paragraph number the publishing court printed on a block, or null.
 *
 * Only a paragraph carries one, and only when the source numbers its
 * paragraphs. A block's anchor (`p-8`) counts every block, headings included,
 * so it is never a court number and nothing here derives one from it. A
 * stored number that is not a positive whole number is not a citable
 * paragraph and reads as none.
 */
export const courtParagraphNumber = (block: {
  readonly type: string;
  readonly number?: number | undefined;
}): number | null =>
  block.type === "paragraph" &&
  block.number !== undefined &&
  Number.isSafeInteger(block.number) &&
  block.number >= 1
    ? block.number
    : null;

/** Every numbered block's court number, by the anchor it is cited by. */
export const courtParagraphNumbersByAnchor = (
  blocks: readonly Block[],
): ReadonlyMap<string, number> => {
  const byAnchor = new Map<string, number>();
  for (const block of blocks) {
    const number = courtParagraphNumber(block);
    if (number !== null) {
      byAnchor.set(block.anchorId, number);
    }
  }
  return byAnchor;
};

/**
 * How a decision's stored paragraphs can be cited. `court`: at least one
 * paragraph carries the number its court printed, which is its label and
 * its `#par=` link. `none`: no paragraph does, because the court numbers
 * nothing or the stored text was read without its numbers, so a passage is
 * named only by stella's position, never a pinpoint to cite.
 */
export const DECISION_PARAGRAPH_NUMBERING = ["court", "none"] as const;

export type DecisionParagraphNumbering =
  (typeof DECISION_PARAGRAPH_NUMBERING)[number];

export const decisionParagraphNumbering = (
  blocks: readonly Parameters<typeof courtParagraphNumber>[0][],
): DecisionParagraphNumbering =>
  blocks.some((block) => courtParagraphNumber(block) !== null)
    ? "court"
    : "none";

/**
 * The list structure of a statute provision, read off its anchors.
 *
 * Each block's anchor names its place in the provision in the grammar of the
 * statute's publisher (`statute-anchor-scheme.ts`). The statute renderer
 * reads the nesting here, through that scheme, for every surface that sets
 * provision text (the statute reader, a provision comparison, a citation's
 * preview card), so none can indent the same wording differently.
 */
import type { ParagraphBlock } from "./document-ast.js";
import {
  anchorListDepth,
  anchorListDesignator,
} from "./statute-anchor-scheme.js";
import type { StatuteAnchorScheme } from "./statute-anchor-scheme.js";

/**
 * A statute paragraph with the list depth its anchor states, unless the
 * publisher stored one. The statute renderer applies it to every paragraph
 * it draws, so no surface that sets statute text can skip it.
 */
export const withStatuteListDepth = (
  block: ParagraphBlock,
  scheme: StatuteAnchorScheme,
): ParagraphBlock => {
  if (block.listDepth !== undefined) {
    return block;
  }
  const listDepth = anchorListDepth(scheme, block.anchorId);
  return listDepth === null ? block : { ...block, listDepth };
};

/**
 * The designator a list item is printed with, wrapped as the publisher
 * prints it (`a)`, `(a)`, `1.`, `1a.`), and the space after it. The value
 * comes from the anchor, so only the subdivision's own designator matches,
 * never a word that happens to open the item.
 */
const printedDesignatorRe = (value: string): RegExp =>
  new RegExp(String.raw`^\(?${RegExp.escape(value)}[).]\s+`, "iu");

/**
 * Where a list item's printed designator ends, with the space after it: the
 * reader hangs `a) ` in a gutter so the item's wrapped lines align with its
 * words, not under its letter. Null when the block is not itself an item
 * (its anchor ends in no list subdivision), its publisher's anchors state no
 * lists, or its text does not open with the designator its anchor names;
 * that block keeps its indent and its designator runs in the text.
 */
export const statuteListMarkerEnd = (
  block: ParagraphBlock,
  scheme: StatuteAnchorScheme,
): number | null => {
  if (block.listDepth === undefined) {
    return null;
  }
  const designator = anchorListDesignator(scheme, block.anchorId);
  if (designator === null) {
    return null;
  }
  const match = printedDesignatorRe(designator).exec(block.plainText);
  return match === null ? null : match[0].length;
};

/** One block of a provision read: its text without kinds or formatting. */
export type PreviewBlock = { anchorId: string; id: string; text: string };

/**
 * A provision read's block as a paragraph the reader can render. The read
 * carries text without kinds or inline formatting; its anchor still states
 * the list nesting, which the statute renderer reads off it as it reads it
 * off the statute's own blocks.
 */
export const paragraphFromPreview = ({
  anchorId,
  id,
  text,
}: PreviewBlock): ParagraphBlock => ({
  anchorId,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

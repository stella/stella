/**
 * The list structure of a statute provision, read off its anchors.
 *
 * e-Sbírka stores a provision as a flat block stream, but each block's stable
 * anchor path names its place in the provision: `par_72a-odst_1` is a
 * paragraph, `…-pism_a` a letter in it, `…-pism_a-bod_1` a point in that
 * letter. The statute renderer reads the nesting here for every surface that
 * sets provision text (the statute reader, a provision comparison, a
 * citation's preview card), so none can indent the same wording differently.
 */
import type { ParagraphBlock, ParagraphListDepth } from "./document-ast.js";

/** How deep each list subdivision sits under the paragraph that opens it. */
const LIST_SEGMENT_DEPTH = {
  pism: 1,
  bod: 2,
} as const satisfies Record<string, ParagraphListDepth>;

type ListSegmentKind = keyof typeof LIST_SEGMENT_DEPTH;

const isListSegmentKind = (kind: string): kind is ListSegmentKind =>
  Object.hasOwn(LIST_SEGMENT_DEPTH, kind);

const ANCHOR_SEGMENT_SEPARATOR = "-";

/** A duplicate's `~2` restates the same subdivision, never a child of it. */
const DUPLICATE_SUFFIX_RE = /~\d+$/u;

type ListSegment = { kind: ListSegmentKind; value: string };

/** One anchor segment (`pism_a`) as the list subdivision it names. */
const listSegment = (segment: string): ListSegment | null => {
  const separator = segment.indexOf("_");
  if (separator <= 0) {
    return null;
  }
  const kind = segment.slice(0, separator);
  const value = segment.slice(separator + 1).replace(DUPLICATE_SUFFIX_RE, "");
  return isListSegmentKind(kind) && value !== "" ? { kind, value } : null;
};

/**
 * How deep a block sits in its provision's list: a letter once, a point in
 * it twice, and whatever an item owns as deep as the item. Null for a block
 * in no list, such as the paragraph whose lead-in the items continue.
 */
const statuteListDepth = (anchorId: string): ParagraphListDepth | null => {
  let depth: ParagraphListDepth | null = null;
  for (const segment of anchorId.split(ANCHOR_SEGMENT_SEPARATOR)) {
    const list = listSegment(segment);
    if (list === null) {
      continue;
    }
    const listDepth = LIST_SEGMENT_DEPTH[list.kind];
    if (depth === null || listDepth > depth) {
      depth = listDepth;
    }
  }
  return depth;
};

/**
 * A statute paragraph with the list depth its anchor states, unless the
 * publisher stored one. The statute renderer applies it to every paragraph
 * it draws, so no surface that sets statute text can skip it.
 */
export const withStatuteListDepth = (block: ParagraphBlock): ParagraphBlock => {
  if (block.listDepth !== undefined) {
    return block;
  }
  const listDepth = statuteListDepth(block.anchorId);
  return listDepth === null ? block : { ...block, listDepth };
};

/**
 * The designator a list item is printed with, wrapped as the publisher
 * prints it (`a)`, `(a)`, `1.`), and the space after it. The value comes from
 * the anchor, so only the subdivision's own designator matches, never a word
 * that happens to open the item.
 */
const printedDesignatorRe = (value: string): RegExp =>
  new RegExp(String.raw`^\(?${RegExp.escape(value)}[).]\s+`, "iu");

/**
 * Where a list item's printed designator ends, with the space after it: the
 * reader hangs `a) ` in a gutter so the item's wrapped lines align with its
 * words, not under its letter. Null when the block is not itself an item
 * (its anchor ends in no list subdivision) or its text does not open with
 * the designator its anchor names; that block keeps its indent and its
 * designator runs in the text.
 */
export const statuteListMarkerEnd = (block: ParagraphBlock): number | null => {
  if (block.listDepth === undefined) {
    return null;
  }
  const innermost = block.anchorId.split(ANCHOR_SEGMENT_SEPARATOR).at(-1);
  const segment = innermost === undefined ? null : listSegment(innermost);
  if (segment === null) {
    return null;
  }
  const match = printedDesignatorRe(segment.value).exec(block.plainText);
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

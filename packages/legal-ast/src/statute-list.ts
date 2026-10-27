/**
 * The list structure of a statute provision, read off its anchors.
 *
 * Publishers store a provision as a flat block stream, but each block's stable
 * anchor path names its place in the provision. Each publisher spells that
 * path in its own grammar: e-Sbírka writes `par_72a-odst_1-pism_a-bod_1`,
 * Slov-Lex `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`. The statute renderer
 * reads the nesting here, through the scheme of the statute's publisher, for
 * every surface that sets provision text (the statute reader, a provision
 * comparison, a citation's preview card), so none can indent the same wording
 * differently.
 */
import { panic } from "better-result";

import type { ParagraphBlock, ParagraphListDepth } from "./document-ast.js";

/**
 * How deep a list item sits, from the list segments its anchor carries.
 *
 * - `kind`: each kind has a fixed depth and the item takes its deepest
 *   segment's (e-Sbírka: a letter once, a point twice).
 * - `nesting`: every list segment opens one more level, so a point in a point
 *   (Slov-Lex `bod-1.bod-1a`) sits under its parent.
 */
type ListDepthRule =
  | { type: "kind"; depths: Readonly<Record<string, ParagraphListDepth>> }
  | { type: "nesting"; kinds: readonly string[] };

/**
 * How a publisher's anchors state list nesting, or why they state none the
 * reader can use.
 *
 * - `nested`: an anchor is segments joined by `segmentSeparator`; a segment
 *   is a kind and a value joined by `kindSeparator` (`pism_a`, `pismeno-a`).
 *   `restatementSuffix` marks a segment that restates its subdivision
 *   (e-Sbírka's `~2`), or is null where the publisher marks none.
 * - `flat`: no item is nested or hung; `reason` says why.
 */
export type StatuteListScheme =
  | {
      type: "nested";
      depth: ListDepthRule;
      kindSeparator: string;
      restatementSuffix: RegExp | null;
      segmentSeparator: string;
    }
  | { type: "flat"; reason: string };

type NestedListScheme = Extract<StatuteListScheme, { type: "nested" }>;

/** e-Sbírka (Czechia): `par_72a-odst_1-pism_a-bod_1`, a duplicate `pism_c~2`. */
export const E_SBIRKA_LIST_SCHEME = {
  type: "nested",
  depth: { type: "kind", depths: { pism: 1, bod: 2 } },
  kindSeparator: "_",
  restatementSuffix: /~\d+$/u,
  segmentSeparator: "-",
} as const satisfies StatuteListScheme;

/** Slov-Lex (Slovakia): `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`. */
export const SLOV_LEX_LIST_SCHEME = {
  type: "nested",
  depth: { type: "nesting", kinds: ["pismeno", "bod"] },
  kindSeparator: "-",
  restatementSuffix: null,
  segmentSeparator: ".",
} as const satisfies StatuteListScheme;

/** A publisher whose anchors give the reader no list nesting to draw. */
export const flatStatuteLists = (reason: string) =>
  ({ type: "flat", reason }) as const satisfies StatuteListScheme;

/** The deepest indent the reader draws; a deeper item sits at it. */
const MAX_LIST_DEPTH = 4 satisfies ParagraphListDepth;

const listDepthOf = (depth: number): ParagraphListDepth => {
  const capped = Math.min(depth, MAX_LIST_DEPTH);
  switch (capped) {
    case 1:
    case 2:
    case 3:
    case 4:
      return capped;
    default:
      return panic(`A list depth below 1: ${String(depth)}`);
  }
};

type ListSegment = { kind: string; value: string };

/** One anchor segment (`pism_a`) as the list subdivision it names. */
const listSegment = (
  scheme: NestedListScheme,
  segment: string,
): ListSegment | null => {
  const separator = segment.indexOf(scheme.kindSeparator);
  if (separator <= 0) {
    return null;
  }
  const kind = segment.slice(0, separator);
  const isListKind =
    scheme.depth.type === "kind"
      ? Object.hasOwn(scheme.depth.depths, kind)
      : scheme.depth.kinds.includes(kind);
  if (!isListKind) {
    return null;
  }
  const raw = segment.slice(separator + scheme.kindSeparator.length);
  const value =
    scheme.restatementSuffix === null
      ? raw
      : raw.replace(scheme.restatementSuffix, "");
  return value === "" ? null : { kind, value };
};

/**
 * How deep a block sits in its provision's list: as its scheme counts its
 * list segments, and whatever an item owns as deep as the item. Null for a
 * block in no list, such as the paragraph whose lead-in the items continue.
 */
const statuteListDepth = (
  scheme: NestedListScheme,
  anchorId: string,
): ParagraphListDepth | null => {
  const segments: ListSegment[] = [];
  for (const raw of anchorId.split(scheme.segmentSeparator)) {
    const segment = listSegment(scheme, raw);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    return null;
  }
  const { depth } = scheme;
  switch (depth.type) {
    case "kind":
      return listDepthOf(
        Math.max(
          ...segments.map(
            ({ kind }) =>
              depth.depths[kind] ?? panic(`List kind ${kind} has no depth`),
          ),
        ),
      );
    case "nesting":
      return listDepthOf(segments.length);
    default:
      depth satisfies never;
      return panic("Unhandled list depth rule");
  }
};

/**
 * A statute paragraph with the list depth its anchor states, unless the
 * publisher stored one. The statute renderer applies it to every paragraph
 * it draws, so no surface that sets statute text can skip it.
 */
export const withStatuteListDepth = (
  block: ParagraphBlock,
  scheme: StatuteListScheme,
): ParagraphBlock => {
  if (block.listDepth !== undefined || scheme.type === "flat") {
    return block;
  }
  const listDepth = statuteListDepth(scheme, block.anchorId);
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
  scheme: StatuteListScheme,
): number | null => {
  if (block.listDepth === undefined || scheme.type === "flat") {
    return null;
  }
  const innermost = block.anchorId.split(scheme.segmentSeparator).at(-1);
  const segment =
    innermost === undefined ? null : listSegment(scheme, innermost);
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

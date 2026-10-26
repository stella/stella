/**
 * The grammar a publisher writes statute anchors in, and every reading of an
 * anchor's path that the readers, previews and provision reads make.
 *
 * A publisher stores a provision as a flat block stream, but each block's
 * stable anchor path names its place in the provision, in the publisher's
 * own grammar: e-Sbírka writes `par_72a-odst_1-pism_a-bod_1`, Slov-Lex
 * `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`, the US Code `s1983/a/1`.
 * Which block nests under which, how deep a list item sits and which
 * designator it prints are all read here, through the scheme of the
 * statute's publisher, so no surface can cut a path on a separator of its
 * own.
 */
import { panic } from "better-result";

import type { ParagraphListDepth } from "./document-ast.js";

/**
 * How a publisher's anchors state their path, or why they state none.
 *
 * - `listed`: an anchor is segments joined by `segmentSeparator`; a segment
 *   is a kind and a value joined by `kindSeparator` (`pism_a`,
 *   `pismeno-a`). `listKinds` names the kinds that are list items, each
 *   with the shallowest depth it is drawn at; an item nested in another
 *   sits one level under it (`pism_b-pism_aa`, `bod-1.bod-1a`).
 *   `restatementSuffix` marks a segment that restates its subdivision
 *   (e-Sbírka's `~2`), or is null where the publisher marks none.
 * - `path`: anchors nest on `segmentSeparator`, but their segments name no
 *   list the reader can draw; `reason` says why.
 * - `whole`: anchors are read whole, so none nests under another; `reason`
 *   says why.
 */
export type StatuteAnchorScheme =
  | {
      type: "listed";
      kindSeparator: string;
      listKinds: Readonly<Record<string, ParagraphListDepth>>;
      restatementSuffix: RegExp | null;
      segmentSeparator: string;
    }
  | { type: "path"; reason: string; segmentSeparator: string }
  | { type: "whole"; reason: string };

type ListedAnchorScheme = Extract<StatuteAnchorScheme, { type: "listed" }>;

/**
 * e-Sbírka (Czechia): `par_72a-odst_1-pism_a-bod_1`, a duplicate `pism_c~2`.
 * A point sits two levels in even where a section opens it directly.
 */
export const E_SBIRKA_ANCHORS = {
  type: "listed",
  kindSeparator: "_",
  listKinds: { pism: 1, bod: 2 },
  restatementSuffix: /~\d+$/u,
  segmentSeparator: "-",
} as const satisfies StatuteAnchorScheme;

/** Slov-Lex (Slovakia): `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`. */
export const SLOV_LEX_ANCHORS = {
  type: "listed",
  kindSeparator: "-",
  listKinds: { pismeno: 1, bod: 1 },
  restatementSuffix: null,
  segmentSeparator: ".",
} as const satisfies StatuteAnchorScheme;

/** The US Code: `s1983/a/1`, where a section number may carry `-` (`s2000e-2`). */
export const US_CODE_ANCHORS = {
  type: "path",
  reason:
    "US Code anchors (`s1983/a/1`) are positional and no stored consolidation sets their depths.",
  segmentSeparator: "/",
} as const satisfies StatuteAnchorScheme;

/**
 * A statute's blocks, or a run of them, with the scheme its publisher's
 * anchors are read in: every reading of a block's path takes both.
 */
export type StatuteBlocks<TBlock extends { anchorId: string }> = {
  blocks: readonly TBlock[];
  scheme: StatuteAnchorScheme;
};

/** A publisher whose anchors are read whole. */
export const wholeStatuteAnchors = (reason: string) =>
  ({ type: "whole", reason }) as const satisfies StatuteAnchorScheme;

/** The separator a scheme's anchors nest on, or null when they nest on none. */
const segmentSeparatorOf = (scheme: StatuteAnchorScheme): string | null => {
  switch (scheme.type) {
    case "listed":
    case "path":
      return scheme.segmentSeparator;
    case "whole":
      return null;
    default:
      scheme satisfies never;
      return panic("Unhandled statute anchor scheme");
  }
};

type AnchorWithinOptions = { ancestor: string; anchor: string };

/**
 * Whether `anchor` sits under `ancestor`: it continues the ancestor's path by
 * at least one more segment. The separator is part of the test, or `odst_2`
 * would own `odst_20`; a restated `pism_c~2` continues no path, so it is
 * never a child of `pism_c`.
 */
export const anchorWithin = (
  scheme: StatuteAnchorScheme,
  { ancestor, anchor }: AnchorWithinOptions,
): boolean => {
  const separator = segmentSeparatorOf(scheme);
  return separator !== null && anchor.startsWith(`${ancestor}${separator}`);
};

type AnchorEndsWithPathOptions = { anchor: string; tail: string };

/**
 * Whether `anchor` ends in the whole segments `tail` names: a citation states
 * the local provision id (`cl_7`) where the publisher files it under a
 * container (`prilohy-cl_7`). Equal anchors are not a tail of each other.
 */
export const anchorEndsWithPath = (
  scheme: StatuteAnchorScheme,
  { anchor, tail }: AnchorEndsWithPathOptions,
): boolean => {
  const separator = segmentSeparatorOf(scheme);
  return separator !== null && anchor.endsWith(`${separator}${tail}`);
};

type ListSegment = { kind: string; value: string };

/** One anchor segment (`pism_a`) as the list item it names, if it names one. */
const listSegment = (
  scheme: ListedAnchorScheme,
  segment: string,
): ListSegment | null => {
  const separator = segment.indexOf(scheme.kindSeparator);
  if (separator <= 0) {
    return null;
  }
  const kind = segment.slice(0, separator);
  if (!Object.hasOwn(scheme.listKinds, kind)) {
    return null;
  }
  const raw = segment.slice(separator + scheme.kindSeparator.length);
  const value =
    scheme.restatementSuffix === null
      ? raw
      : raw.replace(scheme.restatementSuffix, "");
  return value === "" ? null : { kind, value };
};

/** The list items an anchor's path runs through, outermost first. */
const listSegments = (
  scheme: ListedAnchorScheme,
  anchor: string,
): ListSegment[] => {
  const segments: ListSegment[] = [];
  for (const raw of anchor.split(scheme.segmentSeparator)) {
    const segment = listSegment(scheme, raw);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  return segments;
};

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

/**
 * How deep the list item an anchor names sits: each item at least as deep as
 * its kind and one level under the item it is nested in, and whatever an
 * item owns (`pism_a-table_1`) as deep as the item. Null for an anchor in no
 * list, such as the paragraph whose lead-in the items continue, and for every
 * anchor of a scheme that names no lists.
 */
export const anchorListDepth = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): ParagraphListDepth | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  let depth = 0;
  for (const { kind } of listSegments(scheme, anchor)) {
    const floor =
      scheme.listKinds[kind] ?? panic(`List kind ${kind} has no depth`);
    depth = Math.max(floor, depth + 1);
  }
  return depth === 0 ? null : listDepthOf(depth);
};

/**
 * The designator value of the list item an anchor ends in (`a` for
 * `par_2-odst_1-pism_a`), or null when its last segment is no list item.
 */
export const anchorListDesignator = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): string | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  const innermost = anchor.split(scheme.segmentSeparator).at(-1);
  return innermost === undefined
    ? null
    : (listSegment(scheme, innermost)?.value ?? null);
};

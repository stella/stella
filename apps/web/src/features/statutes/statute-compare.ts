import { panic } from "better-result";

import { provisionHeadingLine } from "@stll/decision-reader/reader-outline";
import { resolveDocumentHeadingAnchor } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";
import { provisionPreviewBlocks } from "@stll/legal-ast/provision-preview";
import type {
  StatuteCompareGroup,
  StatuteCompareRow,
} from "@stll/legal-ast/statute-compare";
import type { StatuteCompareSide } from "@stll/legal-ast/statute-diff-marks";
import { paragraphFromPreview } from "@stll/legal-ast/statute-list";
import type { PreviewBlock } from "@stll/legal-ast/statute-list";

import { STATUTE_COMPARE_SHOW } from "@/features/statutes/statute-compare-search";
import type { StatuteCompareShow } from "@/features/statutes/statute-compare-search";
import {
  headingFromPreview,
  prepareStatuteReader,
} from "@/features/statutes/statute-reader-blocks";
import type { PreviewHeading } from "@/features/statutes/statute-reader-blocks";

/** The newer side of a row, or the older one when the block was removed. */
const rowSide = (row: StatuteCompareRow): StatuteCompareSide =>
  row.after ?? row.before ?? panic(`Compare row ${row.key} has no side`);

const rowText = (row: StatuteCompareRow): string =>
  rowSide(row)
    .segments.map((segment) => segment.text)
    .join("");

/**
 * The provision a heading row names: the designation line, which publishers
 * print above or below the caption. A heading that states no designation (a
 * part or a chapter) is named by its last line.
 */
const rowProvision = (row: StatuteCompareRow): string | null => {
  for (const block of rowSide(row).blocks) {
    const line = block.type === "heading" ? provisionHeadingLine(block) : null;
    if (line !== null) {
      return line.text;
    }
  }

  return rowText(row).trim().split("\n").at(-1)?.trim() ?? null;
};

/** Where a row sits in the listed groups, and the provision it belongs to. */
export type CompareRowLocation = {
  groupIndex: number;
  /** The provision's own heading (`§ 12`), null before the first one. */
  provision: string | null;
};

/**
 * Every listed row's group and provision, so a move can name and scroll to
 * its other end. The provision is the innermost heading the group opens with.
 */
export const locateCompareRows = (
  groups: readonly StatuteCompareGroup[],
): ReadonlyMap<string, CompareRowLocation> => {
  const locations = new Map<string, CompareRowLocation>();

  for (const [groupIndex, group] of groups.entries()) {
    const headings = group.rows.filter(
      (row, index) =>
        row.type === "heading" &&
        group.rows.slice(0, index).every((above) => above.type === "heading"),
    );
    const heading = headings.at(-1);
    const provision = heading === undefined ? null : rowProvision(heading);

    for (const row of group.rows) {
      locations.set(row.key, { groupIndex, provision });
    }
  }

  return locations;
};

/** The groups a comparison lists for the chosen filter. */
export const visibleCompareGroups = (
  groups: readonly StatuteCompareGroup[],
  show: StatuteCompareShow,
): readonly StatuteCompareGroup[] =>
  show === STATUTE_COMPARE_SHOW.all
    ? groups
    : groups.filter((group) => group.status === "changed");

/**
 * One consolidation's wording of the compared text, as far as it is known.
 * `unstructured` is a consolidation without a usable document AST: the reader
 * prints its plain text instead, and there are no blocks to align.
 */
export type CompareSideState =
  | { type: "loading" }
  | { type: "absent" }
  | { type: "unstructured" }
  | { type: "ready"; blocks: readonly Block[] };

type ActCompareSideOptions = {
  /** The parsed AST's blocks, or null when it is absent or unparseable. */
  blocks: readonly Block[] | null;
  statuteTitle: string;
};

/**
 * A whole consolidation as the comparison reads it: its blocks as the reader
 * prints them, list depth and notes included. A consolidation the reader
 * shows as plain text (no AST, or one with nothing left to print) is
 * `unstructured`, never an empty act, or the other side would read as added
 * or deleted whole.
 */
export const actCompareSide = ({
  blocks,
  statuteTitle,
}: ActCompareSideOptions): CompareSideState => {
  if (blocks === null) {
    return { type: "unstructured" };
  }
  const prepared = prepareStatuteReader({ blocks, statuteTitle }).blocks;

  return prepared.length === 0
    ? { type: "unstructured" }
    : { type: "ready", blocks: prepared };
};

type ProvisionCompareSideOptions = {
  /** The parsed AST's blocks, or null when it is absent or unparseable. */
  blocks: readonly Block[] | null;
  /** The provision heading's anchor. */
  provision: string;
};

/** A provision read's answer: its own heading and the blocks it owns. */
export type ProvisionWording = {
  heading: PreviewHeading | null;
  blocks: readonly PreviewBlock[];
};

/**
 * A provision's wording as the comparison reads it. The heading is compared
 * with the body: an amendment may change only the designation or the
 * caption, and a body alone would report no change.
 */
export const provisionWordingSide = ({
  blocks,
  heading,
}: ProvisionWording): CompareSideState => ({
  type: "ready",
  blocks: [
    ...(heading === null ? [] : [headingFromPreview(heading)]),
    ...blocks.map(paragraphFromPreview),
  ],
});

/**
 * One provision of a consolidation already in memory, narrowed by the rule
 * the API applies to the other side. A preview carries text without block
 * kinds or inline formatting, so this side is read the way the preview reads
 * a block: a kind or a run of formatting on one side only would count as a
 * change.
 */
export const provisionCompareSide = ({
  blocks,
  provision,
}: ProvisionCompareSideOptions): CompareSideState => {
  if (blocks === null) {
    return { type: "unstructured" };
  }
  const heading = resolveDocumentHeadingAnchor(blocks, provision);
  const owned = provisionPreviewBlocks(blocks, provision, undefined);

  if (heading === null || owned === null) {
    return { type: "absent" };
  }

  return provisionWordingSide({
    heading: {
      anchorId: heading.anchorId,
      id: heading.id,
      level: heading.level,
      text: heading.plainText,
    },
    blocks: owned.map((block) => ({
      anchorId: block.anchorId,
      id: block.id,
      text: block.plainText,
    })),
  });
};

export type PairedCompareSides =
  | { type: "loading" }
  | { type: "unstructured" }
  | {
      type: "both";
      older: readonly Block[];
      newer: readonly Block[];
    }
  | { type: "olderOnly"; blocks: readonly Block[] }
  | { type: "newerOnly"; blocks: readonly Block[] }
  | { type: "neither" };

/**
 * What a comparison can show once both sides answered. A provision only one
 * consolidation carries is a real answer (added, or repealed and dropped), so
 * it is shown one-sided rather than as a diff against nothing.
 */
export const pairCompareSides = ({
  newer,
  older,
}: {
  older: CompareSideState;
  newer: CompareSideState;
}): PairedCompareSides => {
  // Settled without waiting for the other side: nothing it answers makes
  // plain text comparable.
  if (older.type === "unstructured" || newer.type === "unstructured") {
    return { type: "unstructured" };
  }
  if (older.type === "loading" || newer.type === "loading") {
    return { type: "loading" };
  }
  if (older.type === "ready" && newer.type === "ready") {
    return { type: "both", older: older.blocks, newer: newer.blocks };
  }
  if (older.type === "ready") {
    return { type: "olderOnly", blocks: older.blocks };
  }
  if (newer.type === "ready") {
    return { type: "newerOnly", blocks: newer.blocks };
  }

  return { type: "neither" };
};

type ComparableVersion = {
  id: string;
  versionValidFrom: string | null;
};

type ResolveCompareVersionsOptions<V extends ComparableVersion> = {
  /** The `compare` search param: the other consolidation's opening day. */
  compare: string;
  onScreenId: string;
  /** The Work's versions, newest validity window first. */
  versions: readonly V[];
};

export type StatuteCompareVersions<V extends ComparableVersion> =
  | { type: "ready"; older: V; newer: V; other: V }
  | { type: "missing" }
  | { type: "same" };

/**
 * The two consolidations a comparison sets side by side: the one on screen
 * and the one the URL names, the older of them on the left whichever the
 * reader picked.
 */
export const resolveCompareVersions = <V extends ComparableVersion>({
  compare,
  onScreenId,
  versions,
}: ResolveCompareVersionsOptions<V>): StatuteCompareVersions<V> => {
  const otherIndex = versions.findIndex(
    (version) => version.versionValidFrom === compare,
  );
  const onScreenIndex = versions.findIndex(
    (version) => version.id === onScreenId,
  );
  const other = versions.at(otherIndex);
  const onScreen = versions.at(onScreenIndex);

  if (
    otherIndex === -1 ||
    onScreenIndex === -1 ||
    other === undefined ||
    onScreen === undefined
  ) {
    return { type: "missing" };
  }

  if (other.id === onScreen.id) {
    return { type: "same" };
  }

  return otherIndex > onScreenIndex
    ? { type: "ready", older: other, newer: onScreen, other }
    : { type: "ready", older: onScreen, newer: other, other };
};

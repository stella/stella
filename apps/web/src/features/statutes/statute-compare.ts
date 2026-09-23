import { panic } from "better-result";
import type { Result } from "better-result";

import { compareContent } from "@stll/folio-core";
import type {
  FolioContentComparisonError,
  FolioContentComparisonEvent,
} from "@stll/folio-core";
import { diffWordSegments } from "@stll/folio-core/ai-edits";
import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import type { Block } from "@stll/legal-ast/document-ast";
import { provisionPreviewBlocks } from "@stll/legal-ast/provision-preview";

import { STATUTE_COMPARE_SHOW } from "@/features/statutes/statute-compare-search";
import type { StatuteCompareShow } from "@/features/statutes/statute-compare-search";
import {
  compareText,
  hasVisibleChange,
  isWhitespaceReplacement,
} from "@/features/statutes/statute-diff-marks";
import type { StatuteCompareSide } from "@/features/statutes/statute-diff-marks";
import {
  paragraphFromPreview,
  prepareStatuteReader,
} from "@/features/statutes/statute-reader-blocks";

/** What the comparison pairs blocks by: a heading only pairs a heading. */
type CompareBlockKind = "heading" | "text";

type ComparedBlock = {
  id: string;
  kind: CompareBlockKind;
  text: string;
  idStability: "positional";
  headingLevel?: number;
  /** The block the reader renders; the comparison itself reads `text`. */
  block: Block;
};

/**
 * Anchors are not used as identities: a consolidation that numbers a
 * formerly unnumbered paragraph renames its anchor (`frag_…` becomes
 * `par_34-odst_1`), and pairing by text reads that as the rewording it is
 * rather than as a deletion plus an insertion.
 */
const toComparedBlock = (block: Block, index: number): ComparedBlock =>
  block.type === "heading"
    ? {
        id: `b${index}`,
        kind: "heading",
        text: compareText([block]),
        idStability: "positional",
        headingLevel: block.level,
        block,
      }
    : {
        id: `b${index}`,
        kind: "text",
        text: compareText([block]),
        idStability: "positional",
        block,
      };

const astBlocks = (blocks: readonly ComparedBlock[]): Block[] =>
  blocks.map((compared) => compared.block);

/** A side whose wording both versions share, unmarked. */
const unmarkedSide = (blocks: readonly ComparedBlock[]): StatuteCompareSide => {
  const ast = astBlocks(blocks);
  return { blocks: ast, segments: [{ type: "equal", text: compareText(ast) }] };
};

type CompareRowStatus = "unchanged" | "changed";

/**
 * One end of a paragraph that moved: the row where the older consolidation
 * had it (`source`), or the row where the newer one has it (`target`).
 */
export type StatuteCompareMove = {
  end: "source" | "target";
  /** The row at the other end of the move. */
  counterpartKey: string;
};

/**
 * One aligned row: the older wording on the left, the newer on the right.
 * A side is null when that consolidation has no counterpart block; on a
 * moved row, the empty side is where the paragraph went or came from.
 */
export type StatuteCompareRow = {
  key: string;
  type: CompareBlockKind;
  status: CompareRowStatus;
  move: StatuteCompareMove | null;
  before: StatuteCompareSide | null;
  after: StatuteCompareSide | null;
};

type DiffSides = {
  before: WordDiffSegment[];
  after: WordDiffSegment[];
};

/**
 * One segment list, read from each side: the older wording is everything but
 * the insertions, the newer everything but the deletions. Both sides come
 * from the same diff, so what is struck on the left is exactly what the
 * right no longer says.
 *
 * The diff carries a word's leading whitespace with it, so a doubled or
 * non-breaking space reads as the word replaced by itself. Such a
 * replacement is equal on each side: nothing a reader can see changed.
 */
export const splitDiffSides = (
  segments: readonly WordDiffSegment[],
): DiffSides => {
  const before: WordDiffSegment[] = [];
  const after: WordDiffSegment[] = [];

  let pairedWithPrevious = false;

  for (const [index, segment] of segments.entries()) {
    if (pairedWithPrevious) {
      pairedWithPrevious = false;
      continue;
    }
    const next = segments.at(index + 1);

    if (next !== undefined && isWhitespaceReplacement(segment, next)) {
      const [removed, added] =
        segment.type === "del" ? [segment, next] : [next, segment];
      before.push({ type: "equal", text: removed.text });
      after.push({ type: "equal", text: added.text });
      pairedWithPrevious = true;
      continue;
    }

    switch (segment.type) {
      case "equal":
        before.push(segment);
        after.push(segment);
        break;
      case "del":
        before.push(segment);
        break;
      case "ins":
        after.push(segment);
        break;
      default:
        segment.type satisfies never;
        panic("Unhandled word diff segment");
    }
  }

  return { before, after };
};

type RowFromSegmentsOptions = {
  key: string;
  segments: readonly WordDiffSegment[];
  base: readonly ComparedBlock[];
  revised: readonly [ComparedBlock, ...ComparedBlock[]];
};

/**
 * A paired row. Whitespace alone does not make it changed: the renderer
 * marks nothing for it, and a row listed as changed with nothing marked
 * reads as a fault.
 */
const rowFromSegments = ({
  base,
  key,
  revised,
  segments,
}: RowFromSegmentsOptions): StatuteCompareRow => {
  const { after, before } = splitDiffSides(segments);

  return {
    key,
    type: revised[0].kind,
    status:
      hasVisibleChange(before) || hasVisibleChange(after)
        ? "changed"
        : "unchanged",
    move: null,
    before: { blocks: astBlocks(base), segments: before },
    after: { blocks: astBlocks(revised), segments: after },
  };
};

const rowKey = (index: number): string => `r${index}`;

type ComparisonEvent = FolioContentComparisonEvent<ComparedBlock>;

/** Both ends of one move, each with its own side of the rewording it carried. */
type MoveEnds = {
  sourceKey: string;
  targetKey: string;
  before: StatuteCompareSide;
  after: StatuteCompareSide;
};

type MoveSource = { key: string; block: ComparedBlock };

/**
 * Folio reports a move as two events, one where the paragraph left and one
 * where it arrived; the rewording travels on the arriving one. Each row needs
 * both, so the events are paired once up front.
 */
const indexMoves = (
  events: readonly ComparisonEvent[],
): ReadonlyMap<number, MoveEnds> => {
  const sources = new Map<number, MoveSource>();
  const targets = new Map<
    number,
    {
      key: string;
      block: ComparedBlock;
      segments: readonly WordDiffSegment[] | undefined;
    }
  >();

  for (const [index, event] of events.entries()) {
    if (event.type === "movedFrom") {
      sources.set(event.moveId, {
        key: rowKey(index),
        block: event.baseBlocks[0],
      });
    }
    if (event.type === "movedTo") {
      targets.set(event.moveId, {
        key: rowKey(index),
        block: event.revisedBlocks[0],
        segments: event.segments,
      });
    }
  }

  const moves = new Map<number, MoveEnds>();
  for (const [moveId, source] of sources) {
    const target = targets.get(moveId);
    if (target === undefined) {
      return panic("Folio reported a move without its destination");
    }
    // A move that carried no rewording states no segments; each end then
    // reads as its own wording, unmarked.
    const sides =
      target.segments === undefined
        ? {
            before: unmarkedSide([source.block]),
            after: unmarkedSide([target.block]),
          }
        : {
            before: {
              blocks: astBlocks([source.block]),
              segments: splitDiffSides(target.segments).before,
            },
            after: {
              blocks: astBlocks([target.block]),
              segments: splitDiffSides(target.segments).after,
            },
          };
    moves.set(moveId, {
      ...sides,
      sourceKey: source.key,
      targetKey: target.key,
    });
  }
  if (moves.size !== targets.size) {
    return panic("Folio reported a move without its origin");
  }

  return moves;
};

const moveEnds = (
  moves: ReadonlyMap<number, MoveEnds>,
  moveId: number,
): MoveEnds => moves.get(moveId) ?? panic("Unpaired content move");

/** A side only one version has, marked whole. */
const wholeSide = (
  blocks: readonly ComparedBlock[],
  type: "del" | "ins",
): StatuteCompareSide => {
  const ast = astBlocks(blocks);
  return { blocks: ast, segments: [{ type, text: compareText(ast) }] };
};

/**
 * The row one comparison event is drawn as. A moved paragraph gets a row at
 * each end, each naming the other, so the reader sees where it went rather
 * than a deletion here and an unrelated insertion there.
 */
const rowFromEvent = (
  event: ComparisonEvent,
  index: number,
  moves: ReadonlyMap<number, MoveEnds>,
): StatuteCompareRow => {
  const key = rowKey(index);

  switch (event.type) {
    case "unchanged":
    case "formatting":
      return {
        key,
        type: event.revisedBlocks[0].kind,
        status: "unchanged",
        move: null,
        before: unmarkedSide(event.baseBlocks),
        after: unmarkedSide(event.revisedBlocks),
      };
    case "modified":
      return rowFromSegments({
        key,
        segments: event.segments,
        base: event.baseBlocks,
        revised: event.revisedBlocks,
      });
    case "inserted":
      return {
        key,
        type: event.revisedBlocks[0].kind,
        status: "changed",
        move: null,
        before: null,
        after: wholeSide(event.revisedBlocks, "ins"),
      };
    case "deleted":
      return {
        key,
        type: event.baseBlocks[0].kind,
        status: "changed",
        move: null,
        before: wholeSide(event.baseBlocks, "del"),
        after: null,
      };
    case "movedFrom": {
      const ends = moveEnds(moves, event.moveId);
      return {
        key,
        type: event.baseBlocks[0].kind,
        status: "changed",
        move: { end: "source", counterpartKey: ends.targetKey },
        before: ends.before,
        after: null,
      };
    }
    case "movedTo": {
      const ends = moveEnds(moves, event.moveId);
      return {
        key,
        type: event.revisedBlocks[0].kind,
        status: "changed",
        move: { end: "target", counterpartKey: ends.sourceKey },
        before: null,
        after: ends.after,
      };
    }
    case "split":
    case "merge":
      return rowFromSegments({
        key,
        segments: diffWordSegments(
          compareText(astBlocks(event.baseBlocks)),
          compareText(astBlocks(event.revisedBlocks)),
        ),
        base: event.baseBlocks,
        revised: event.revisedBlocks,
      });
    default:
      event satisfies never;
      return panic("Unhandled content comparison event");
  }
};

type CompareStatuteBlocksOptions = {
  older: readonly Block[];
  newer: readonly Block[];
};

/**
 * Two consolidations' blocks aligned row by row with Folio's content
 * comparison, each row carrying the blocks it shows and its word diff.
 */
export const compareStatuteBlocks = ({
  newer,
  older,
}: CompareStatuteBlocksOptions): Result<
  StatuteCompareRow[],
  FolioContentComparisonError
> =>
  compareContent({
    base: { blocks: older.map(toComparedBlock) },
    revised: { blocks: newer.map(toComparedBlock) },
  }).map(({ events }) => {
    const moves = indexMoves(events);

    return events.map((event, index) => rowFromEvent(event, index, moves));
  });

/** A provision's rows: its heading run and the text under it. */
export type StatuteCompareGroup = {
  key: string;
  status: CompareRowStatus;
  rows: StatuteCompareRow[];
};

/**
 * Rows grouped into provisions. A heading opens a group, and the headings
 * stacked right above it (part, title, division) open it with it, so a
 * changed first section of a division still shows where it stands.
 */
export const groupCompareRows = (
  rows: readonly StatuteCompareRow[],
): StatuteCompareGroup[] => {
  const groups: StatuteCompareGroup[] = [];
  let previous: StatuteCompareRow | undefined;

  for (const row of rows) {
    const opensGroup = row.type === "heading" && previous?.type !== "heading";
    const current = groups.at(-1);

    if (current === undefined || opensGroup) {
      groups.push({ key: row.key, status: row.status, rows: [row] });
    } else {
      current.rows.push(row);
      if (row.status === "changed") {
        current.status = "changed";
      }
    }
    previous = row;
  }

  return groups;
};

const rowText = (row: StatuteCompareRow): string =>
  (row.after ?? row.before)?.segments.map((segment) => segment.text).join("") ??
  "";

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
    // A captioned section prints its caption above the number, and a heading
    // row split or merged between versions joins both lines; the number is
    // the last line either way.
    const provision =
      heading === undefined
        ? null
        : (rowText(heading).trim().split("\n").at(-1)?.trim() ?? null);

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
  const owned = provisionPreviewBlocks(blocks, provision, undefined);

  return owned === null
    ? { type: "absent" }
    : {
        type: "ready",
        blocks: owned.map((block) =>
          paragraphFromPreview({
            anchorId: block.anchorId,
            id: block.id,
            text: block.plainText,
          }),
        ),
      };
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

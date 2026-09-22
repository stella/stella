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

import { STATUTE_COMPARE_SHOW } from "@/features/statutes/statute-compare-search";
import type { StatuteCompareShow } from "@/features/statutes/statute-compare-search";

/** One block of a consolidation, as much of it as the comparison reads. */
export type StatuteCompareBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; text: string };

/** An AST block as the comparison reads it: headings keep their depth. */
export const compareBlockFromAst = (block: Block): StatuteCompareBlock =>
  block.type === "heading"
    ? { type: "heading", level: block.level, text: block.plainText }
    : { type: "text", text: block.plainText };

type ComparedBlock = {
  id: string;
  kind: StatuteCompareBlock["type"];
  text: string;
  idStability: "positional";
  headingLevel?: number;
};

/**
 * Anchors are not used as identities: a consolidation that numbers a
 * formerly unnumbered paragraph renames its anchor (`frag_…` becomes
 * `par_34-odst_1`), and pairing by text reads that as the rewording it is
 * rather than as a deletion plus an insertion.
 */
const toComparedBlock = (
  block: StatuteCompareBlock,
  index: number,
): ComparedBlock =>
  block.type === "heading"
    ? {
        id: `b${index}`,
        kind: "heading",
        text: block.text,
        idStability: "positional",
        headingLevel: block.level,
      }
    : {
        id: `b${index}`,
        kind: "text",
        text: block.text,
        idStability: "positional",
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
  type: StatuteCompareBlock["type"];
  status: CompareRowStatus;
  move: StatuteCompareMove | null;
  before: readonly WordDiffSegment[] | null;
  after: readonly WordDiffSegment[] | null;
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
 */
export const splitDiffSides = (
  segments: readonly WordDiffSegment[],
): DiffSides => {
  const before: WordDiffSegment[] = [];
  const after: WordDiffSegment[] = [];

  for (const segment of segments) {
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

const hasChange = (segments: readonly WordDiffSegment[]): boolean =>
  segments.some((segment) => segment.type !== "equal");

type RowFromSegmentsOptions = {
  key: string;
  segments: readonly WordDiffSegment[];
  type: StatuteCompareBlock["type"];
};

const rowFromSegments = ({
  key,
  segments,
  type,
}: RowFromSegmentsOptions): StatuteCompareRow => {
  const { after, before } = splitDiffSides(segments);

  return {
    key,
    type,
    status: hasChange(segments) ? "changed" : "unchanged",
    move: null,
    before,
    after,
  };
};

const joinedText = (blocks: readonly ComparedBlock[]): string =>
  blocks.map((block) => block.text).join("\n");

const rowKey = (index: number): string => `r${index}`;

type ComparisonEvent = FolioContentComparisonEvent<ComparedBlock>;

/** Both ends of one move, and the rewording it carried, if any. */
type MoveEnds = {
  sourceKey: string;
  targetKey: string;
  segments: readonly WordDiffSegment[];
};

/**
 * Folio reports a move as two events, one where the paragraph left and one
 * where it arrived; the rewording travels on the arriving one. Each row needs
 * both, so the events are paired once up front.
 */
const indexMoves = (
  events: readonly ComparisonEvent[],
): ReadonlyMap<number, MoveEnds> => {
  const sources = new Map<number, string>();
  const targets = new Map<
    number,
    { key: string; segments: readonly WordDiffSegment[] }
  >();

  for (const [index, event] of events.entries()) {
    if (event.type === "movedFrom") {
      sources.set(event.moveId, rowKey(index));
    }
    if (event.type === "movedTo") {
      targets.set(event.moveId, {
        key: rowKey(index),
        segments: event.segments ?? [
          { type: "equal", text: event.revisedBlocks[0].text },
        ],
      });
    }
  }

  const moves = new Map<number, MoveEnds>();
  for (const [moveId, sourceKey] of sources) {
    const target = targets.get(moveId);
    if (target === undefined) {
      return panic("Folio reported a move without its destination");
    }
    moves.set(moveId, {
      segments: target.segments,
      sourceKey,
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
        before: [{ type: "equal", text: event.baseBlocks[0].text }],
        after: [{ type: "equal", text: event.revisedBlocks[0].text }],
      };
    case "modified":
      return rowFromSegments({
        key,
        segments: event.segments,
        type: event.revisedBlocks[0].kind,
      });
    case "inserted":
      return {
        key,
        type: event.revisedBlocks[0].kind,
        status: "changed",
        move: null,
        before: null,
        after: [{ type: "ins", text: event.revisedBlocks[0].text }],
      };
    case "deleted":
      return {
        key,
        type: event.baseBlocks[0].kind,
        status: "changed",
        move: null,
        before: [{ type: "del", text: event.baseBlocks[0].text }],
        after: null,
      };
    case "movedFrom": {
      const ends = moveEnds(moves, event.moveId);
      return {
        key,
        type: event.baseBlocks[0].kind,
        status: "changed",
        move: { end: "source", counterpartKey: ends.targetKey },
        before: splitDiffSides(ends.segments).before,
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
        after: splitDiffSides(ends.segments).after,
      };
    }
    case "split":
    case "merge":
      return rowFromSegments({
        key,
        segments: diffWordSegments(
          joinedText(event.baseBlocks),
          joinedText(event.revisedBlocks),
        ),
        type: event.revisedBlocks[0].kind,
      });
    default:
      event satisfies never;
      return panic("Unhandled content comparison event");
  }
};

type CompareStatuteBlocksOptions = {
  older: readonly StatuteCompareBlock[];
  newer: readonly StatuteCompareBlock[];
};

/**
 * Two consolidations' blocks aligned row by row with Folio's content
 * comparison, each changed row carrying its word diff.
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
  (row.after ?? row.before ?? []).map((segment) => segment.text).join("");

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

/** One consolidation's wording of the compared text, as far as it is known. */
export type CompareSideState =
  | { type: "loading" }
  | { type: "absent" }
  | { type: "ready"; blocks: readonly StatuteCompareBlock[] };

export type PairedCompareSides =
  | { type: "loading" }
  | {
      type: "both";
      older: readonly StatuteCompareBlock[];
      newer: readonly StatuteCompareBlock[];
    }
  | { type: "olderOnly"; blocks: readonly StatuteCompareBlock[] }
  | { type: "newerOnly"; blocks: readonly StatuteCompareBlock[] }
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

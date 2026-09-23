import { panic } from "better-result";

import {
  REVIEW_SUGGESTION_ORIGIN,
  REVIEW_UNSPECIFIED_AREA,
} from "@/components/ai-suggestions/review-store";
import type {
  ReviewSuggestion,
  ReviewSuggestionStatus,
} from "@/components/ai-suggestions/review-store";
import { folioOperationBlockId } from "@/components/ai-suggestions/review-suggestion-builder";

export type ReviewBarAction = "resolve" | "revert" | "busy" | "resolved";

/** The suggestions one review decision covers, never empty. */
export type ReviewChangeMembers = readonly [
  ReviewSuggestion,
  ...ReviewSuggestion[],
];

/**
 * One decision in the review queue: the suggestions a reviewer accepts,
 * rejects or reverts together.
 *
 * Derived from the session on every read and never stored, so a queued, a
 * hydrated and a reloaded session group the same way. Persistence and the
 * audit trail stay per suggestion; only the review surfaces see changes.
 */
export type ReviewChange =
  | {
      type: "single";
      /** The member's id. */
      id: string;
      members: readonly [ReviewSuggestion];
    }
  | {
      /** Chat deletions of consecutive paragraphs, sharing one status. */
      type: "deletionRun";
      /** The first member's id; stable while that member leads the run. */
      id: string;
      members: readonly [
        ReviewSuggestion,
        ReviewSuggestion,
        ...ReviewSuggestion[],
      ];
    };

export const mapReviewChangeMembers = <T>(
  members: ReviewChangeMembers,
  map: (member: ReviewSuggestion) => T,
): readonly [T, ...T[]] => {
  const [first, ...rest] = members;
  return [map(first), ...rest.map(map)];
};

const reviewChangeFromMembers = (
  members: ReviewChangeMembers,
): ReviewChange => {
  const [first, second, ...rest] = members;
  return second === undefined
    ? { type: "single", id: first.id, members: [first] }
    : { type: "deletionRun", id: first.id, members: [first, second, ...rest] };
};

/** A suggestion that is its own decision, as every review finding's fix is. */
export const reviewChangeOf = (suggestion: ReviewSuggestion): ReviewChange => ({
  type: "single",
  id: suggestion.id,
  members: [suggestion],
});

/** Members of a change share one status; grouping only merges equal ones. */
export const reviewChangeStatus = (
  change: ReviewChange,
): ReviewSuggestionStatus => change.members[0].status;

export const reviewChangeHasMember = (
  change: ReviewChange,
  suggestionId: string | null,
): boolean =>
  suggestionId !== null &&
  change.members.some((member) => member.id === suggestionId);

const canRevertReviewSuggestion = (suggestion: ReviewSuggestion): boolean => {
  switch (suggestion.status) {
    case "accepted":
      return suggestion.revisionIds !== null || suggestion.undoHandle !== null;
    case "rejected":
    case "skipped":
      return true;
    case "applying":
    case "pending":
      return false;
    default:
      suggestion.status satisfies never;
      return panic(`Unhandled status: ${String(suggestion.status)}`);
  }
};

export const canRevertReviewChange = (change: ReviewChange): boolean =>
  change.members.every(canRevertReviewSuggestion);

export const getReviewBarAction = (change: ReviewChange): ReviewBarAction => {
  const status = reviewChangeStatus(change);
  switch (status) {
    case "pending":
      return "resolve";
    case "applying":
      return "busy";
    case "rejected":
    case "skipped":
      return "revert";
    case "accepted":
      return canRevertReviewChange(change) ? "revert" : "resolved";
    default:
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
  }
};

/**
 * What a review list shows of a queue.
 *
 * `hideAccepted` drops everything except `pending` and `applying`. The
 * "applying" status stays so the loading indicator doesn't flicker out from
 * under the reviewer mid-apply. Filtered after grouping: hiding a resolved
 * suggestion must not merge the changes on either side of it.
 */
export const filterReviewChanges = (
  changes: readonly ReviewChange[],
  options: { hideAccepted: boolean },
): readonly ReviewChange[] =>
  options.hideAccepted
    ? changes.filter((change) => {
        const status = reviewChangeStatus(change);
        return status === "pending" || status === "applying";
      })
    : changes;

type ReviewBarPosition = {
  activeIndex: number;
  current: number;
  total: number;
};

/**
 * Keep the focus id valid across store hydration and session replacement.
 * A new review starts at its first pending change; an already-resolved
 * session still has a deterministic first item for inspection. Focus on any
 * member of a change counts as focus on the change.
 */
export const getReviewBarFocusTarget = (
  changes: readonly ReviewChange[],
  focusedId: string | null,
): string | null => {
  if (changes.some((change) => reviewChangeHasMember(change, focusedId))) {
    return null;
  }
  return (
    (
      changes.find((change) => reviewChangeStatus(change) === "pending") ??
      changes.at(0)
    )?.id ?? null
  );
};

/**
 * The counter and navigation deliberately use the full session. Resolved
 * changes stay addressable so the reviewer can inspect or revert them;
 * pending/applying state only controls each change's available action.
 */
export const getReviewBarPosition = (
  changes: readonly ReviewChange[],
  focusedId: string | null,
): ReviewBarPosition => {
  const total = changes.length;
  if (total === 0) {
    return { activeIndex: 0, current: 0, total: 0 };
  }
  const focusedIndex = changes.findIndex((change) =>
    reviewChangeHasMember(change, focusedId),
  );
  const activeIndex = Math.max(focusedIndex, 0);
  return {
    activeIndex,
    current: activeIndex + 1,
    total,
  };
};

/**
 * What a change does, before it is put into words. `text` is a stored,
 * already translated line; the other branches name the message that renders
 * a deletion run.
 */
export type ReviewChangeSummary =
  | { type: "text"; text: string }
  | { type: "deleteParagraphRange"; first: string; last: string }
  | { type: "deleteParagraphs"; count: number };

/**
 * A single change reads as its stored summary. A deletion run names its first
 * and last clause when both have one, and otherwise counts the paragraphs it
 * removes; two deletions of one paragraph still read as that paragraph.
 */
export const describeReviewChangeSummary = (
  change: ReviewChange,
): ReviewChangeSummary => {
  switch (change.type) {
    case "single":
      return { type: "text", text: change.members[0].summary };
    case "deletionRun": {
      const [first, ...rest] = change.members;
      const last = rest.at(-1) ?? first;
      const paragraphCount = new Set(
        change.members.map((member) => member.blockId),
      ).size;
      if (paragraphCount === 1) {
        return { type: "text", text: first.summary };
      }
      const firstLabel = first.blockLabel?.trim() ?? "";
      const lastLabel = last.blockLabel?.trim() ?? "";
      return firstLabel.length > 0 &&
        lastLabel.length > 0 &&
        firstLabel !== lastLabel
        ? { type: "deleteParagraphRange", first: firstLabel, last: lastLabel }
        : { type: "deleteParagraphs", count: paragraphCount };
    }
    default:
      change satisfies never;
      return panic(`Unhandled review change: ${String(change)}`);
  }
};

/**
 * The bar's first line: what this decision is about.
 *
 * A review finding stages its fix as a suggestion whose `area` is the issue
 * the run raised ("Liability cap", "Governing law") — the sentence the
 * reviewer is being asked to rule on. A change proposed in the chat has no
 * finding behind it, so what it does IS the reason, and its summary says that
 * in words. `area` also falls back to the summary when a run left it
 * unspecified, so the bar is never blank or labelled "Unspecified".
 */
export const reviewBarHeading = (change: ReviewChange): ReviewChangeSummary => {
  const [first] = change.members;
  const area = first.area.trim();
  return first.origin === REVIEW_SUGGESTION_ORIGIN.review &&
    area.length > 0 &&
    area !== REVIEW_UNSPECIFIED_AREA
    ? { type: "text", text: area }
    : describeReviewChangeSummary(change);
};

/**
 * A block of the reviewed document, in the order the editor walks it. Both
 * `FolioAIBlock` and a snapshot block satisfy this structurally.
 */
export type DocumentOrderedBlock = {
  id: string;
  displayLabel?: string | undefined;
};

/** Sorts after every block the document knows about. */
const UNPLACED = Number.POSITIVE_INFINITY;

type BlockIndex = {
  byId: ReadonlyMap<string, number>;
  byLabel: ReadonlyMap<string, number>;
};

const indexBlocks = (blocks: readonly DocumentOrderedBlock[]): BlockIndex => {
  const byLabel = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    const label = block.displayLabel?.trim() ?? "";
    if (label.length > 0 && !byLabel.has(label)) {
      byLabel.set(label, index);
    }
  }
  return {
    byId: new Map(blocks.map((block, index) => [block.id, index])),
    byLabel,
  };
};

/**
 * Where one suggestion lands in the document, as an index into `blocks`.
 *
 * Three addresses, weakest last. The pending operation is authoritative: it
 * names the block the accept will actually edit. The suggestion's own
 * `blockId` covers a resolved item whose operation was consumed. The clause
 * label is the last resort, for a suggestion hydrated against a document that
 * has since been re-parsed and re-minted its ids — "2.1" still points at the
 * right paragraph when the handle no longer does.
 */
const documentPositionOf = (
  suggestion: ReviewSuggestion,
  { byId, byLabel }: BlockIndex,
): number => {
  const operationBlockId =
    suggestion.pendingOperation === null
      ? null
      : folioOperationBlockId(suggestion.pendingOperation);
  const byOperation =
    operationBlockId === null ? undefined : byId.get(operationBlockId);
  if (byOperation !== undefined) {
    return byOperation;
  }
  const byBlockId = byId.get(suggestion.blockId);
  if (byBlockId !== undefined) {
    return byBlockId;
  }
  const label = suggestion.blockLabel?.trim() ?? "";
  return (label.length === 0 ? undefined : byLabel.get(label)) ?? UNPLACED;
};

/**
 * The review queue in reading order.
 *
 * The store holds a session in the order it was hydrated — findings by
 * severity, then the chat's proposals — which makes "next" jump around the
 * document. A reviewer walks a contract top to bottom, so the stepper, the
 * counter and accept-and-advance all read this ordering instead.
 *
 * Stable: suggestions on the same block keep their store order, and every
 * suggestion whose block the editor does not know about (a stale anchor, or a
 * document that has not finished loading) sorts last, in store order, rather
 * than being dropped or floated to the top.
 *
 * `blocks` empty means the editor is not readable yet; the session is returned
 * unchanged, so the bar reads exactly as it does today until the snapshot
 * arrives.
 */
export const orderSuggestionsByDocumentPosition = (
  suggestions: readonly ReviewSuggestion[],
  blocks: readonly DocumentOrderedBlock[],
): readonly ReviewSuggestion[] => {
  if (blocks.length === 0 || suggestions.length < 2) {
    return suggestions;
  }
  const index = indexBlocks(blocks);

  return suggestions
    .map((suggestion, storeIndex) => ({
      suggestion,
      storeIndex,
      position: documentPositionOf(suggestion, index),
    }))
    .toSorted((a, b) =>
      a.position === b.position
        ? a.storeIndex - b.storeIndex
        : a.position - b.position,
    )
    .map(({ suggestion }) => suggestion);
};

type PlacedSuggestion = { suggestion: ReviewSuggestion; position: number };

const isChatDeletion = (suggestion: ReviewSuggestion): boolean =>
  suggestion.origin === REVIEW_SUGGESTION_ORIGIN.chat &&
  suggestion.pendingOperation?.type === "deleteBlock";

/**
 * An accepted change is one apply batch: its members share the batch's undo
 * handle, and reverting the change undoes that batch. Accepted suggestions
 * from separate batches, or hydrated ones that carry no handle, stay apart
 * even when their blocks are adjacent.
 */
const sharesApplyTransaction = (
  previous: ReviewSuggestion,
  next: ReviewSuggestion,
): boolean => {
  switch (previous.status) {
    case "accepted":
      return (
        previous.undoHandle !== null &&
        previous.undoHandle.id === next.undoHandle?.id
      );
    case "pending":
    case "applying":
    case "rejected":
    case "skipped":
      return true;
    default:
      previous.status satisfies never;
      return panic(`Unhandled status: ${String(previous.status)}`);
  }
};

/**
 * A review finding's fix answers that finding, so it never joins another
 * suggestion. Unplaced suggestions never join either: `UNPLACED` is not a
 * position two blocks can be adjacent at.
 *
 * A run is applied as one batch against one snapshot, and an operation's
 * block id only means something against the snapshot it was proposed on, so
 * members must share the same snapshot object. One tool call, or one hydration
 * pass, hands all of its suggestions the same reference. Hydration hands one
 * snapshot to every row it reads, so the proposal batch is compared as well:
 * one reload must not merge deletions that separate proposals made. Equal
 * severity keeps a change's severity one value wherever it is read.
 */
const continuesDeletionRun = (
  previous: PlacedSuggestion,
  next: PlacedSuggestion,
): boolean =>
  isChatDeletion(previous.suggestion) &&
  isChatDeletion(next.suggestion) &&
  previous.suggestion.status === next.suggestion.status &&
  previous.suggestion.proposalBatchId === next.suggestion.proposalBatchId &&
  previous.suggestion.severity === next.suggestion.severity &&
  sharesApplyTransaction(previous.suggestion, next.suggestion) &&
  previous.suggestion.snapshot !== null &&
  previous.suggestion.snapshot === next.suggestion.snapshot &&
  Number.isFinite(previous.position) &&
  (next.position === previous.position ||
    next.position === previous.position + 1);

/**
 * The review queue as decisions.
 *
 * `suggestions` must already be in document order
 * (`orderSuggestionsByDocumentPosition`). The chat deletes a section one
 * paragraph per operation; a reviewer reads a heading and its body going away
 * as one change, so consecutive chat deletions of adjacent blocks with the
 * same status become one change. Everything else is a change of its own.
 */
export const groupReviewChanges = (
  suggestions: readonly ReviewSuggestion[],
  blocks: readonly DocumentOrderedBlock[],
): readonly ReviewChange[] => {
  const index = indexBlocks(blocks);
  const runs: [ReviewSuggestion, ...ReviewSuggestion[]][] = [];
  let previous: PlacedSuggestion | null = null;
  for (const suggestion of suggestions) {
    const placed = {
      suggestion,
      position: documentPositionOf(suggestion, index),
    };
    const run = runs.at(-1);
    if (
      run !== undefined &&
      previous !== null &&
      continuesDeletionRun(previous, placed)
    ) {
      run.push(suggestion);
    } else {
      runs.push([suggestion]);
    }
    previous = placed;
  }
  return runs.map(reviewChangeFromMembers);
};

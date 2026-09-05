import { panic } from "better-result";

import {
  REVIEW_SUGGESTION_ORIGIN,
  REVIEW_UNSPECIFIED_AREA,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { folioOperationBlockId } from "@/components/ai-suggestions/review-suggestion-builder";

export type ReviewBarAction = "resolve" | "revert" | "busy" | "resolved";

export const canRevertReviewSuggestion = (
  suggestion: ReviewSuggestion,
): boolean => {
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

export const getReviewBarAction = (
  suggestion: ReviewSuggestion,
): ReviewBarAction => {
  switch (suggestion.status) {
    case "pending":
      return "resolve";
    case "applying":
      return "busy";
    case "rejected":
    case "skipped":
      return "revert";
    case "accepted":
      return canRevertReviewSuggestion(suggestion) ? "revert" : "resolved";
    default:
      suggestion.status satisfies never;
      return panic(`Unhandled status: ${String(suggestion.status)}`);
  }
};

type ReviewBarPosition = {
  activeIndex: number;
  current: number;
  total: number;
};

/**
 * Keep the focus id valid across store hydration and session replacement.
 * A new review starts at its first pending suggestion; an already-resolved
 * session still has a deterministic first item for inspection.
 */
export const getReviewBarFocusTarget = (
  suggestions: readonly ReviewSuggestion[],
  focusedId: string | null,
): string | null => {
  if (focusedId !== null && suggestions.some((item) => item.id === focusedId)) {
    return null;
  }
  return (
    (suggestions.find((item) => item.status === "pending") ?? suggestions.at(0))
      ?.id ?? null
  );
};

/**
 * The counter and navigation deliberately use the full session. Resolved
 * suggestions stay addressable so the reviewer can inspect or revert them;
 * pending/applying state only controls each item's available action.
 */
export const getReviewBarPosition = (
  suggestions: readonly ReviewSuggestion[],
  focusedId: string | null,
): ReviewBarPosition => {
  const total = suggestions.length;
  if (total === 0) {
    return { activeIndex: 0, current: 0, total: 0 };
  }
  const focusedIndex = suggestions.findIndex((item) => item.id === focusedId);
  const activeIndex = Math.max(focusedIndex, 0);
  return {
    activeIndex,
    current: activeIndex + 1,
    total: suggestions.length,
  };
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
export const reviewBarHeading = (suggestion: ReviewSuggestion): string => {
  const area = suggestion.area.trim();
  return suggestion.origin === REVIEW_SUGGESTION_ORIGIN.review &&
    area.length > 0 &&
    area !== REVIEW_UNSPECIFIED_AREA
    ? area
    : suggestion.summary;
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
  indexById: ReadonlyMap<string, number>,
  indexByLabel: ReadonlyMap<string, number>,
): number => {
  const operationBlockId =
    suggestion.pendingOperation === null
      ? null
      : folioOperationBlockId(suggestion.pendingOperation);
  const byOperation =
    operationBlockId === null ? undefined : indexById.get(operationBlockId);
  if (byOperation !== undefined) {
    return byOperation;
  }
  const byBlockId = indexById.get(suggestion.blockId);
  if (byBlockId !== undefined) {
    return byBlockId;
  }
  const label = suggestion.blockLabel?.trim() ?? "";
  return (label.length === 0 ? undefined : indexByLabel.get(label)) ?? UNPLACED;
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
  const indexById = new Map(blocks.map((block, index) => [block.id, index]));
  const indexByLabel = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    const label = block.displayLabel?.trim() ?? "";
    if (label.length > 0 && !indexByLabel.has(label)) {
      indexByLabel.set(label, index);
    }
  }

  return suggestions
    .map((suggestion, storeIndex) => ({
      suggestion,
      storeIndex,
      position: documentPositionOf(suggestion, indexById, indexByLabel),
    }))
    .sort((a, b) =>
      a.position === b.position
        ? a.storeIndex - b.storeIndex
        : a.position - b.position,
    )
    .map(({ suggestion }) => suggestion);
};

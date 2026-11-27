import type { Mark, MarkType } from "@tiptap/pm/model";
import type { Command } from "@tiptap/pm/state";

import { DELETION_MARK, INSERTION_MARK } from "./clause-tracked-change-marks";

/**
 * Accept and reject commands for the clause editor's tracked changes.
 *
 * An AI rewrite is shown as insertion and deletion marks on the text of the
 * paragraphs it changed (see `buildTrackedChangeDoc`); the paragraphs
 * themselves are never added or removed. Resolving a change is therefore a
 * matter of its text: accepting keeps inserted text and removes deleted
 * text, rejecting does the reverse, and the text that stays loses its mark.
 */

type Resolution = "accept" | "reject";

type TrackedRange = { from: number; to: number; removed: boolean };

const revisionIdOf = (mark: Mark): unknown => mark.attrs["revisionId"];

/**
 * Resolves the tracked changes of `revisionIds`, or all of them when it is
 * null. One revision resolved on its own reports `false` when the document
 * holds no change of it; resolving all with nothing to resolve succeeds.
 */
const resolveTrackedChanges =
  (mode: Resolution, revisionIds: readonly number[] | null): Command =>
  (state, dispatch) => {
    const insertion: MarkType | undefined = state.schema.marks[INSERTION_MARK];
    const deletion: MarkType | undefined = state.schema.marks[DELETION_MARK];
    if (insertion === undefined || deletion === undefined) {
      return false;
    }
    const selects = (mark: Mark): boolean =>
      (mark.type === insertion || mark.type === deletion) &&
      (revisionIds === null ||
        revisionIds.some((id) => id === revisionIdOf(mark)));
    const ranges: TrackedRange[] = [];
    state.doc.descendants((node, position) => {
      if (!node.isInline) {
        return true;
      }
      const tracked = node.marks.filter(selects);
      if (tracked.length > 0) {
        // Text goes when the change that marks it is undone: a deletion
        // that is accepted, an insertion that is rejected.
        const removedBy = mode === "accept" ? deletion : insertion;
        ranges.push({
          from: position,
          to: position + node.nodeSize,
          removed: tracked.some(({ type }) => type === removedBy),
        });
      }
      return false;
    });
    if (ranges.length === 0) {
      return revisionIds === null;
    }
    if (dispatch === undefined) {
      return true;
    }
    const transaction = state.tr;
    // From the end of the document, so the ranges in front keep their place.
    for (const { from, to, removed } of ranges.toReversed()) {
      if (removed) {
        transaction.delete(from, to);
      } else {
        transaction.removeMark(from, to, insertion);
        transaction.removeMark(from, to, deletion);
      }
    }
    dispatch(transaction);
    return true;
  };

const idsOf = (revisionIds: number | readonly number[]): readonly number[] =>
  typeof revisionIds === "number" ? [revisionIds] : revisionIds;

/** Accepts every tracked change in the document. */
export const acceptAllChanges = (): Command =>
  resolveTrackedChanges("accept", null);

/** Rejects every tracked change in the document. */
export const rejectAllChanges = (): Command =>
  resolveTrackedChanges("reject", null);

/** Accepts the tracked changes of one AI edit, by its revision id or ids. */
export const acceptAIEditRevision = (
  revisionIds: number | readonly number[],
): Command => resolveTrackedChanges("accept", idsOf(revisionIds));

/** Rejects the tracked changes of one AI edit, by its revision id or ids. */
export const rejectAIEditRevision = (
  revisionIds: number | readonly number[],
): Command => resolveTrackedChanges("reject", idsOf(revisionIds));

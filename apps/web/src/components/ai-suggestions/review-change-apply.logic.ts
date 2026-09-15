/**
 * Applying one review change to the editor: every member operation in a
 * single document-operation batch, or none of them.
 */

import { panic } from "better-result";

import type {
  DocxEditorRef,
  FolioAIEditApplyMode,
  FolioAIEditOperation,
} from "@stll/folio-react";

import { mapReviewChangeMembers } from "@/components/ai-suggestions/review-bar.logic";
import type { ReviewChangeMembers } from "@/components/ai-suggestions/review-bar.logic";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { folioOperationBlockId } from "@/components/ai-suggestions/review-suggestion-builder";

const DOCUMENT_OPERATION_CONTRACT_VERSION = 1 as const;

export type ApplyOutcome = {
  status: "accepted" | "skipped";
  revisionIds: readonly number[] | null;
  undoHandle: ReviewSuggestion["undoHandle"];
  /**
   * The apply mode the operation was actually applied with. Recorded on the
   * suggestion so a later re-apply (the revert-recovery path) restores the
   * change with the mode it was originally accepted under, not whatever mode
   * the picker happens to show now.
   */
  appliedMode: FolioAIEditApplyMode;
  skipReason?: string;
};

type MemberApplyOutcome = {
  member: ReviewSuggestion;
  outcome: ApplyOutcome;
};

export type MemberApplyOutcomes = readonly [
  MemberApplyOutcome,
  ...MemberApplyOutcome[],
];

type DocumentOperationResult = ReturnType<
  DocxEditorRef["applyDocumentOperations"]
>;

export type ReviewChangeApplyEditor = {
  applyDocumentOperations: (
    options: Parameters<DocxEditorRef["applyDocumentOperations"]>[0],
  ) => Pick<DocumentOperationResult, "applied" | "skipped" | "undoHandle">;
  createAIEditSnapshot: DocxEditorRef["createAIEditSnapshot"];
  rejectAIEditOperation: DocxEditorRef["rejectAIEditOperation"];
  undoDocumentOperations: DocxEditorRef["undoDocumentOperations"];
};

export const skipEveryMember = (
  members: ReviewChangeMembers,
  mode: FolioAIEditApplyMode,
  skipReason: string,
): MemberApplyOutcomes =>
  mapReviewChangeMembers(members, (member) => ({
    member,
    outcome: {
      status: "skipped",
      revisionIds: null,
      undoHandle: null,
      appliedMode: mode,
      skipReason,
    },
  }));

type AppliedOperation = DocumentOperationResult["applied"][number];

const revisionIdsOf = (applied: AppliedOperation): readonly number[] | null =>
  applied.revisionIds ??
  (applied.revisionId === undefined ? null : [applied.revisionId]);

const undoLandedOperations = (
  editor: ReviewChangeApplyEditor,
  result: Pick<DocumentOperationResult, "applied" | "undoHandle">,
): void => {
  if (result.applied.length === 0) {
    return;
  }
  if (
    result.undoHandle !== null &&
    editor.undoDocumentOperations(result.undoHandle).status === "undone"
  ) {
    return;
  }
  const revisionIds: number[] = [];
  for (const applied of result.applied) {
    const ids = revisionIdsOf(applied);
    if (ids !== null) {
      revisionIds.push(...ids);
    }
  }
  if (revisionIds.length > 0) {
    editor.rejectAIEditOperation(revisionIds);
  }
};

export type ReviewChangeUndoEditor = Pick<
  ReviewChangeApplyEditor,
  "rejectAIEditOperation" | "undoDocumentOperations"
>;

/**
 * Take a change's accepted operations back out of the document. Tracked marks
 * are rejected by revision id, which holds however the document moved since.
 * A direct-mode accept left no marks, so the batch's undo handle is the only
 * lever, and members accepted in one batch share it. Returns whether the
 * editor took everything back.
 */
export const undoAcceptedMembers = (
  editor: ReviewChangeUndoEditor | null,
  members: readonly Pick<ReviewSuggestion, "revisionIds" | "undoHandle">[],
): boolean => {
  const revisionIds = new Set<number>();
  for (const { revisionIds: memberRevisionIds } of members) {
    if (memberRevisionIds === null) {
      continue;
    }
    for (const id of memberRevisionIds) {
      revisionIds.add(id);
    }
  }
  if (revisionIds.size > 0) {
    return editor?.rejectAIEditOperation([...revisionIds]) === true;
  }
  const undoHandle =
    members.find((member) => member.undoHandle !== null)?.undoHandle ?? null;
  if (undoHandle === null) {
    return true;
  }
  return editor?.undoDocumentOperations(undoHandle).status === "undone";
};

type ApplyReviewChangeOptions = {
  editor: ReviewChangeApplyEditor;
  members: ReviewChangeMembers;
  mode: FolioAIEditApplyMode;
  author: string;
};

/**
 * Apply a change's member operations as one batch.
 *
 * Members that target the same block send one operation and share its
 * revision ids. The batch is atomic from the reviewer's side: unless every
 * distinct operation applies, whatever landed is undone and every member is
 * skipped with the first reason the editor gave.
 *
 * Resolved against the snapshot the AI saw, NOT a fresh one off the live
 * editor: resolving a queued op against a recomputed snapshot can map its
 * block id to a different block than the AI intended. Grouping only puts
 * suggestions that share one snapshot into a change, so the first member's is
 * every member's. A live snapshot stands in only for a suggestion that
 * shipped without one, which is always a change of its own.
 */
export const applyReviewChange = ({
  editor,
  members,
  mode,
  author,
}: ApplyReviewChangeOptions): MemberApplyOutcomes => {
  const snapshot = members[0].snapshot ?? editor.createAIEditSnapshot();
  if (!snapshot) {
    return skipEveryMember(members, mode, "documentNotEditable");
  }

  const operationByBlock = new Map<string, FolioAIEditOperation>();
  for (const member of members) {
    const operation = member.pendingOperation;
    if (operation === null) {
      return skipEveryMember(members, mode, "documentNotEditable");
    }
    const blockId = folioOperationBlockId(operation);
    if (!operationByBlock.has(blockId)) {
      operationByBlock.set(blockId, operation);
    }
  }
  const operations = [...operationByBlock.values()];

  const result = editor.applyDocumentOperations({
    snapshot,
    batch: {
      version: DOCUMENT_OPERATION_CONTRACT_VERSION,
      mode,
      atomic: true,
      operations,
    },
    ...(author.length > 0 && { author }),
  });
  const appliedById = new Map(
    result.applied.map((applied) => [applied.id, applied]),
  );
  if (operations.some((operation) => !appliedById.has(operation.id))) {
    undoLandedOperations(editor, result);
    return skipEveryMember(
      members,
      mode,
      result.skipped.at(0)?.reason ?? "unsupportedBlock",
    );
  }

  return mapReviewChangeMembers(members, (member) => {
    const operation =
      member.pendingOperation === null
        ? undefined
        : operationByBlock.get(folioOperationBlockId(member.pendingOperation));
    const applied =
      operation === undefined ? undefined : appliedById.get(operation.id);
    if (applied === undefined) {
      return panic("Every member's operation was checked as applied");
    }
    const revisionIds = revisionIdsOf(applied);
    return {
      member,
      outcome: {
        status: "accepted",
        revisionIds,
        undoHandle: result.undoHandle,
        appliedMode:
          mode === "tracked-changes" && revisionIds === null ? "direct" : mode,
      },
    };
  });
};

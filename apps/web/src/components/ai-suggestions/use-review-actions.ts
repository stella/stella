/**
 * useReviewActions — the single owner of accept / reject / revert /
 * batch / navigate behaviour for AI DOCX suggestions.
 *
 * Both the inspector ReviewPanel and the floating ReviewBar consume
 * this hook, so the two surfaces resolve a suggestion the exact same
 * way (apply the tracked-change op, record the outcome on the store,
 * keep `pendingOperation` for a later revert) and can never drift.
 */

import type { RefObject } from "react";

import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { DocxEditorRef, FolioAIEditApplyMode } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/components/toast";

import {
  getReviewApplyMode,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getWordEditAuthorName } from "@/routes/_protected.chat/-hooks/use-chat-user-context";

const DOCUMENT_OPERATION_CONTRACT_VERSION = 1 as const;

type ApplyOutcome = {
  status: "accepted" | "skipped";
  revisionIds: readonly number[] | null;
  undoHandle: ReviewSuggestion["undoHandle"];
  skipReason?: string;
};

export type UseReviewActionsOptions = {
  entityId: string;
  docxEditorRef: RefObject<DocxEditorRef | null>;
  /** Whether the editor currently accepts edit operations. */
  docxEditable: boolean;
  /**
   * Prompt the user to unlock the document. Resolves to true on
   * success, false if the user cancels. Called before an apply while
   * the editor is locked.
   */
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
};

export type ReviewActions = {
  applyMode: FolioAIEditApplyMode;
  setApplyMode: (mode: FolioAIEditApplyMode) => void;
  /** Apply a single pending suggestion as a tracked change (or direct). */
  acceptOne: (item: ReviewSuggestion) => Promise<void>;
  /** Reject a single pending suggestion (kept revertible). */
  rejectOne: (item: ReviewSuggestion) => void;
  /** Put an accepted / rejected suggestion back into the pending queue. */
  revertOne: (item: ReviewSuggestion) => void;
  /** Apply every pending suggestion in `items`, in order. */
  acceptMany: (items: readonly ReviewSuggestion[]) => Promise<void>;
  /** Reject every pending suggestion in `items`. */
  rejectMany: (items: readonly ReviewSuggestion[]) => void;
  /** Focus a suggestion and scroll the document to it. */
  navigateTo: (item: ReviewSuggestion) => void;
};

export const useReviewActions = ({
  entityId,
  docxEditorRef,
  docxEditable,
  requestDocxEditMode,
}: UseReviewActionsOptions): ReviewActions => {
  const t = useTranslations();
  const applyMode = useReviewStore((state) =>
    getReviewApplyMode(state, entityId),
  );
  const updateSuggestion = useReviewStore((state) => state.updateSuggestion);
  const setStatusBatch = useReviewStore((state) => state.setStatusBatch);
  const setApplyModeAction = useReviewStore((state) => state.setApplyMode);
  const setFocusedId = useReviewStore((state) => state.setFocusedId);
  // Author the tracked-change marks as the user (their preferred name
  // from account settings): they are accepting the AI's suggestion AS
  // THEMSELVES, not as "AI".
  const wordAuthor = useRouteContext({
    from: "/_protected",
    select: (ctx) =>
      getWordEditAuthorName({
        name: ctx.user.name ?? null,
        preferredName: ctx.user.preferredName ?? null,
        wordEditShortcut: ctx.user.wordEditShortcut ?? null,
      }),
  });

  const setApplyMode = useLatestCallback((mode: FolioAIEditApplyMode) => {
    setApplyModeAction(entityId, mode);
  });

  const ensureUnlocked = useLatestCallback(async (): Promise<boolean> => {
    if (docxEditable) {
      return true;
    }
    if (!requestDocxEditMode) {
      return false;
    }
    return await requestDocxEditMode();
  });

  /**
   * Apply a single pending operation. Returns the resulting status the
   * store should record, plus the revisionIds on success in
   * tracked-changes mode (a replace produces two ids, an insert/delete
   * one).
   */
  const applyPending = useLatestCallback(
    (item: ReviewSuggestion): ApplyOutcome => {
      const editor = docxEditorRef.current;
      const op = item.pendingOperation;
      if (!editor || !op) {
        return {
          status: "skipped",
          revisionIds: null,
          undoHandle: null,
          skipReason: "documentNotEditable",
        };
      }

      // Use the snapshot the AI saw when it generated this op, NOT a
      // fresh one off the live editor. Block ids are sequential and get
      // renumbered after any insertAfterBlock accept; resolving a queued
      // op against a recomputed snapshot would map "b-0042" to a
      // different block than the AI intended. Fall back to a live
      // snapshot only if the AI op shipped without one (legacy/test).
      const snapshot = item.snapshot ?? editor.createAIEditSnapshot();
      if (!snapshot) {
        return {
          status: "skipped",
          revisionIds: null,
          undoHandle: null,
          skipReason: "documentNotEditable",
        };
      }

      const result = editor.applyDocumentOperations({
        snapshot,
        batch: {
          version: DOCUMENT_OPERATION_CONTRACT_VERSION,
          mode: applyMode,
          operations: [op],
        },
        ...(wordAuthor.length > 0 && { author: wordAuthor }),
      });
      const applied = result.applied.at(0);
      if (applied) {
        return {
          status: "accepted",
          revisionIds: applied.revisionIds ?? null,
          undoHandle: result.undoHandle,
        };
      }
      const skipped = result.skipped.at(0);
      return {
        status: "skipped",
        revisionIds: null,
        undoHandle: null,
        skipReason: skipped?.reason ?? "unsupportedBlock",
      };
    },
  );

  const recordOutcome = useLatestCallback(
    (item: ReviewSuggestion, outcome: ApplyOutcome) => {
      // Keep `pendingOperation` even after a successful accept so a later
      // "Revert" can put the suggestion back into review without losing
      // the original operation spec. The lifecycle's source of truth is
      // `status`, not the presence of `pendingOperation`.
      updateSuggestion(entityId, item.id, {
        status: outcome.status,
        revisionIds: outcome.revisionIds,
        undoHandle: outcome.undoHandle,
        applyMode: outcome.status === "accepted" ? applyMode : null,
        ...(outcome.skipReason !== undefined && {
          skipReason: outcome.skipReason,
        }),
      });
    },
  );

  const acceptOne = useLatestCallback(async (item: ReviewSuggestion) => {
    if (item.status !== "pending") {
      return;
    }
    const unlocked = await ensureUnlocked();
    if (!unlocked) {
      return;
    }
    // Optimistic state — the card shows "Applying…" the instant the user
    // clicks. Without this the click feels dead because the editor apply
    // is synchronous and React hasn't painted between state mutations.
    // Yield to the macrotask queue before the actual apply so the
    // "applying" status can paint first.
    updateSuggestion(entityId, item.id, { status: "applying" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    recordOutcome(item, applyPending(item));
  });

  const rejectOne = useLatestCallback((item: ReviewSuggestion) => {
    if (item.status !== "pending") {
      return;
    }
    // Same reason as accept: don't drop pendingOperation, so the user can
    // revert the rejection and the suggestion goes back to actionable.
    updateSuggestion(entityId, item.id, { status: "rejected" });
  });

  const revertOne = useLatestCallback((item: ReviewSuggestion) => {
    if (item.status === "pending") {
      return;
    }
    if (item.status === "accepted" && item.undoHandle !== null) {
      const undoResult = docxEditorRef.current?.undoDocumentOperations(
        item.undoHandle,
      );
      if (undoResult?.status !== "undone") {
        stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        return;
      }
    }
    updateSuggestion(entityId, item.id, {
      status: "pending",
      revisionIds: null,
      undoHandle: null,
      applyMode: null,
      skipReason: undefined,
    });
  });

  const acceptMany = useLatestCallback(
    async (items: readonly ReviewSuggestion[]) => {
      const targets = items.filter((item) => item.status === "pending");
      if (targets.length === 0) {
        return;
      }
      const unlocked = await ensureUnlocked();
      if (!unlocked) {
        return;
      }
      for (const item of targets) {
        recordOutcome(item, applyPending(item));
      }
    },
  );

  const rejectMany = useLatestCallback((items: readonly ReviewSuggestion[]) => {
    const targets = items.filter((item) => item.status === "pending");
    if (targets.length === 0) {
      return;
    }
    setStatusBatch(
      entityId,
      targets.map((item) => item.id),
      "rejected",
    );
  });

  const navigateTo = useLatestCallback((item: ReviewSuggestion) => {
    setFocusedId(entityId, item.id);
    // Pending items don't have revision ids yet (nothing applied), so
    // scroll by the snapshot blockId. Once accepted in tracked-changes
    // mode the revision-ids path snaps to the exact insertion/deletion
    // marks instead.
    if (item.revisionIds !== null) {
      docxEditorRef.current?.scrollToAIEditOperation(item.revisionIds);
      return;
    }
    docxEditorRef.current?.scrollToBlock(
      item.blockId,
      item.snapshot ?? undefined,
    );
  });

  return {
    applyMode,
    setApplyMode,
    acceptOne,
    rejectOne,
    revertOne,
    acceptMany,
    rejectMany,
    navigateTo,
  };
};

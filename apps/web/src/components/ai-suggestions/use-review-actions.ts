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
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { DocxEditorRef, FolioAIEditApplyMode } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/components/toast";

import {
  getReviewApplyMode,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
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
  /**
   * Workspace the entity lives in. Scopes the persistence calls that
   * fire (server-side) when a `persisted` suggestion is resolved or
   * reverted.
   */
  workspaceId: string;
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
  workspaceId,
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

  // --- Persistence (audit trail) -----------------------------------------
  //
  // Only `persisted` suggestions (a server row exists) hit the server.
  // Every call is fire-and-forget and never rolls back local/editor
  // state: a failure captures telemetry + shows one toast, but the
  // in-memory review continues exactly as it did before persistence.

  const resolveOnServer = useLatestCallback(
    async (
      item: ReviewSuggestion,
      status: "accepted" | "rejected",
      appliedMode: FolioAIEditApplyMode | null,
    ): Promise<boolean> => {
      const result = await Result.tryPromise(
        async () =>
          await api["docx-suggestions"]({ workspaceId })
            .entity({ entityId })
            .suggestion({ suggestionId: item.id })
            .resolve.patch({ status, appliedMode }),
      );
      if (Result.isError(result)) {
        getAnalytics().captureError(result.error);
        return false;
      }
      if (result.value.error) {
        getAnalytics().captureError(toAPIError(result.value.error));
        return false;
      }
      return true;
    },
  );

  const revertOnServer = useLatestCallback(
    async (item: ReviewSuggestion): Promise<boolean> => {
      const result = await Result.tryPromise(
        async () =>
          await api["docx-suggestions"]({ workspaceId })
            .entity({ entityId })
            .suggestion({ suggestionId: item.id })
            .revert.patch(),
      );
      if (Result.isError(result)) {
        getAnalytics().captureError(result.error);
        return false;
      }
      if (result.value.error) {
        getAnalytics().captureError(toAPIError(result.value.error));
        return false;
      }
      return true;
    },
  );

  const toastPersistFailed = useLatestCallback(() => {
    stellaToast.add({ title: t("docxReview.persistFailed"), type: "error" });
  });

  type ResolveTarget = {
    item: ReviewSuggestion;
    status: "accepted" | "rejected";
    appliedMode: FolioAIEditApplyMode | null;
  };

  // Resolve a batch server-side, surfacing at most one toast if any
  // member failed.
  const persistResolveBatch = useLatestCallback((targets: ResolveTarget[]) => {
    if (targets.length === 0) {
      return;
    }
    void (async () => {
      // Independent PATCHes, so resolve them in parallel and surface a
      // single toast if any failed.
      const results = await Promise.all(
        targets.map(
          async ({ item, status, appliedMode }) =>
            await resolveOnServer(item, status, appliedMode),
        ),
      );
      if (results.some((ok) => !ok)) {
        toastPersistFailed();
      }
    })();
  });

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
    const outcome = applyPending(item);
    recordOutcome(item, outcome);
    // Persist the resolution only when the apply actually landed; a
    // `skipped` op leaves the row pending server-side so it can be
    // retried. `appliedMode` mirrors what `recordOutcome` stored.
    if (item.persisted === true && outcome.status === "accepted") {
      void (async () => {
        const ok = await resolveOnServer(item, "accepted", applyMode);
        if (!ok) {
          toastPersistFailed();
        }
      })();
    }
  });

  const rejectOne = useLatestCallback((item: ReviewSuggestion) => {
    if (item.status !== "pending") {
      return;
    }
    // Same reason as accept: don't drop pendingOperation, so the user can
    // revert the rejection and the suggestion goes back to actionable.
    updateSuggestion(entityId, item.id, { status: "rejected" });
    if (item.persisted === true) {
      void (async () => {
        const ok = await resolveOnServer(item, "rejected", null);
        if (!ok) {
          toastPersistFailed();
        }
      })();
    }
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
    if (item.persisted === true) {
      void (async () => {
        const ok = await revertOnServer(item);
        if (!ok) {
          toastPersistFailed();
        }
      })();
    }
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
      // The API has no batch-resolve, so persist per accepted+persisted
      // item after the local batch apply. One toast at most on failure.
      const toPersist: ResolveTarget[] = [];
      for (const item of targets) {
        const outcome = applyPending(item);
        recordOutcome(item, outcome);
        if (item.persisted === true && outcome.status === "accepted") {
          toPersist.push({ item, status: "accepted", appliedMode: applyMode });
        }
      }
      persistResolveBatch(toPersist);
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
    persistResolveBatch(
      targets
        .filter((item) => item.persisted === true)
        .map((item) => ({
          item,
          status: "rejected" as const,
          appliedMode: null,
        })),
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

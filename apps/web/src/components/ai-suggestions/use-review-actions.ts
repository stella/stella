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

import type { DocxResolveResult } from "@/components/ai-suggestions/docx-suggestion-persistence";
import {
  resolveDocxSuggestionRequest,
  revertDocxSuggestionRequest,
} from "@/components/ai-suggestions/docx-suggestion-persistence";
import {
  findLiveSuggestion,
  getReviewApplyMode,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type {
  ReviewSuggestion,
  ReviewSuggestionStatus,
} from "@/components/ai-suggestions/review-store";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { getWordEditAuthorName } from "@/routes/_protected.chat/-hooks/use-chat-user-context";

const DOCUMENT_OPERATION_CONTRACT_VERSION = 1 as const;

/**
 * Per-suggestion server-mutation ordering queue, keyed by the globally unique
 * suggestion id. Module-level (not a per-hook ref) so it is SHARED across every
 * surface that mounts `useReviewActions` for the same suggestion — the review
 * bar and the inspector panel are normally co-mounted, and an accept from one
 * plus a revert from the other must still serialize against each other.
 * Entries self-clean once their tail promise settles, so the map cannot grow.
 */
const docxSuggestionMutationChain = new Map<string, Promise<unknown>>();

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

  // Read the CURRENT store row for an id captured before an await. Follows a
  // `reconcileServerIds` rename (client ref -> server id) so an in-flight
  // accept/reject that captured the client ref still finds its row after the
  // background persist lands in the gap.
  const readLive = useLatestCallback(
    (capturedId: string): ReviewSuggestion | undefined =>
      findLiveSuggestion(
        useReviewStore.getState().sessions[entityId],
        capturedId,
      ),
  );

  // Atomically claim a still-pending row from the LIVE store, flipping it to
  // `claimStatus`. Returns the claimed row (the caller now owns it) or null if
  // it was already non-pending — a concurrent double-click, or an Accept-all
  // fired from the other surface, already claimed it. The read-check-set runs
  // synchronously with no await between, so only one caller can win the claim.
  const claimPending = useLatestCallback(
    (
      capturedId: string,
      claimStatus: ReviewSuggestionStatus,
    ): ReviewSuggestion | null => {
      const live = readLive(capturedId);
      if (live === undefined || live.status !== "pending") {
        return null;
      }
      updateSuggestion(entityId, live.id, { status: claimStatus });
      return live;
    },
  );

  // Release a claim back to pending, following any reconcile rename that
  // happened while the claim was held (so the release targets the row's
  // current id, not the captured ref).
  const releaseClaim = useLatestCallback((capturedId: string) => {
    const live = readLive(capturedId);
    if (live === undefined) {
      return;
    }
    updateSuggestion(entityId, live.id, { status: "pending" });
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
  // Unlike the old fire-and-forget flow, a server disagreement now
  // reconciles local/editor state so the two can never permanently
  // diverge:
  //   - "failed" (transport error): roll the local resolution BACK and
  //     capture telemetry, so the user can retry against a clean state.
  //   - "stale" (the server row was not in the expected state — already
  //     resolved elsewhere / a concurrent write won): roll the local
  //     resolution back too (server is authoritative) but do not treat it
  //     as an error for telemetry.
  //   - "synced": nothing to do.

  // Per-suggestion serialization queue. A suggestion's server mutations
  // (resolve / revert) must run in submission order: a fast Accept-then-
  // Revert could otherwise send the revert first — it would hit a still-
  // `pending` server row, return `"stale"` (treated as a local no-op) while
  // the resolve lands afterward and flips the server row to `accepted`,
  // leaving local pending / server accepted so a reload re-arms the
  // suggestion. Chaining each id's network calls guarantees the revert runs
  // AFTER the accept's resolve completes (server ends accepted, then the
  // revert legitimately flips it back to pending — consistent). Optimistic
  // local state changes stay immediate; only the network calls are ordered.
  const runSerialized = useLatestCallback(
    async (
      id: string,
      task: () => Promise<DocxResolveResult>,
    ): Promise<DocxResolveResult> => {
      const prev = docxSuggestionMutationChain.get(id) ?? Promise.resolve();
      const next = prev.then(
        async () => await task(),
        async () => await task(),
      );
      docxSuggestionMutationChain.set(id, next);
      detached(
        next.finally(() => {
          if (docxSuggestionMutationChain.get(id) === next) {
            docxSuggestionMutationChain.delete(id);
          }
        }),
        "useReviewActions",
      );
      return await next;
    },
  );

  const toastPersistFailed = useLatestCallback(() => {
    stellaToast.add({ title: t("docxReview.persistFailed"), type: "error" });
  });

  const toastStaleResolution = useLatestCallback(() => {
    stellaToast.add({
      title: t("docxReview.staleResolution"),
      type: "warning",
    });
  });

  const captureResolveFailure = (context: string) => {
    getAnalytics().captureError(
      new Error(`DOCX suggestion ${context} failed to persist`),
    );
  };

  // Undo the editor op (if one landed) and put the suggestion back to
  // pending. Shared by acceptOne / acceptMany so a persist disagreement
  // rewinds an accept identically everywhere. Captures telemetry only for
  // a true transport failure, not for a "stale" server row.
  const rollbackAcceptedResolution = useLatestCallback(
    (
      item: ReviewSuggestion,
      undoHandle: ReviewSuggestion["undoHandle"],
      result: Exclude<DocxResolveResult, "synced">,
    ) => {
      if (result === "failed") {
        captureResolveFailure("accept");
      }
      if (undoHandle !== null) {
        docxEditorRef.current?.undoDocumentOperations(undoHandle);
      }
      updateSuggestion(entityId, item.id, {
        status: "pending",
        revisionIds: null,
        undoHandle: null,
        applyMode: null,
      });
    },
  );

  // Put a rejected suggestion back to pending after a persist disagreement.
  const rollbackRejectedResolution = useLatestCallback(
    (item: ReviewSuggestion, result: Exclude<DocxResolveResult, "synced">) => {
      if (result === "failed") {
        captureResolveFailure("reject");
      }
      updateSuggestion(entityId, item.id, { status: "pending" });
    },
  );

  // Surface at most one toast for a batch of resolve results, preferring
  // the transport failure over a stale-row reconcile.
  const surfaceBatchResolveToast = useLatestCallback(
    (results: readonly DocxResolveResult[]) => {
      if (results.some((result) => result === "failed")) {
        toastPersistFailed();
        return;
      }
      if (results.some((result) => result === "stale")) {
        toastStaleResolution();
      }
    },
  );

  const acceptOne = useLatestCallback(async (item: ReviewSuggestion) => {
    // Claim synchronously from the LIVE store, not the render-time snapshot:
    // a rapid double-click fires two acceptOne calls that both captured a
    // "pending" item, so checking `item.status` lets both through. `claimPending`
    // reads the current status and flips it to "applying" before any await, so
    // only the first proceeds.
    if (claimPending(item.id, "applying") === null) {
      return;
    }
    const unlocked = await ensureUnlocked();
    if (!unlocked) {
      // Release the claim so a cancelled unlock leaves the card actionable.
      releaseClaim(item.id);
      return;
    }
    // Yield to the macrotask queue so the "applying" status can paint before
    // the synchronous editor apply.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // Re-read the LIVE row: the background persist can land in the unlock/paint
    // gap and `reconcileServerIds` renames the row (client ref -> server id) and
    // flips `persisted` true. Driving `recordOutcome` + the resolve off the
    // captured `item` would write to the stale client id (a no-op after the
    // rename), stranding the row "applying" while the server stays pending —
    // a reload would then re-arm it as actionable. Follow the row to its
    // current identity and operate on that instead.
    const live = readLive(item.id);
    if (live === undefined || live.status !== "applying") {
      // Our claim was lost (a reconcile collapse dropped the row, or another
      // handler took it over). Nothing to apply.
      return;
    }
    const outcome = applyPending(live);
    recordOutcome(live, outcome);
    // Persist the resolution only when the apply actually landed; a
    // `skipped` op leaves the row pending server-side so it can be
    // retried. `appliedMode` mirrors what `recordOutcome` stored. `live.persisted`
    // is read post-reconcile, so an accept that raced the create response still
    // fires its resolve here rather than relying on the persist-window replay.
    if (live.persisted === true && outcome.status === "accepted") {
      detached(
        (async () => {
          const result = await runSerialized(
            live.id,
            async () =>
              await resolveDocxSuggestionRequest({
                workspaceId,
                entityId,
                suggestionId: live.id,
                status: "accepted",
                appliedMode: applyMode,
              }),
          );
          if (result === "synced") {
            return;
          }
          // The editor applied the change but the server row is not in
          // "accepted": rewind the editor + local state so the user sees the
          // suggestion pending again, matching the server.
          rollbackAcceptedResolution(live, outcome.undoHandle, result);
          if (result === "failed") {
            toastPersistFailed();
          } else {
            toastStaleResolution();
          }
        })(),
        "useReviewActions",
      );
    }
  });

  const rejectOne = useLatestCallback((item: ReviewSuggestion) => {
    // Claim from the LIVE store, same as accept: a rapid double-click fires two
    // rejectOne calls that both captured a "pending" item. Without the claim the
    // second call enqueues a resolve that comes back "stale" (updated:false) and
    // `rollbackRejectedResolution` flips the shared card back to pending while
    // the server row stays rejected — the UI re-arms and diverges from the
    // durable state. `claimPending` (flip pending -> rejected before scheduling)
    // lets only the first through.
    const claimed = claimPending(item.id, "rejected");
    if (claimed === null) {
      return;
    }
    // Same reason as accept: don't drop pendingOperation, so the user can
    // revert the rejection and the suggestion goes back to actionable.
    if (claimed.persisted === true) {
      detached(
        (async () => {
          const result = await runSerialized(
            claimed.id,
            async () =>
              await resolveDocxSuggestionRequest({
                workspaceId,
                entityId,
                suggestionId: claimed.id,
                status: "rejected",
                appliedMode: null,
              }),
          );
          if (result === "synced") {
            return;
          }
          rollbackRejectedResolution(claimed, result);
          if (result === "failed") {
            toastPersistFailed();
          } else {
            toastStaleResolution();
          }
        })(),
        "useReviewActions",
      );
    }
  });

  const revertOne = useLatestCallback((item: ReviewSuggestion) => {
    if (item.status === "pending") {
      return;
    }
    // Snapshot the pre-revert resolution so a persist failure can put the
    // suggestion back exactly where it was (server stays terminal, so the
    // editor must too).
    const prev = {
      status: item.status,
      revisionIds: item.revisionIds,
      undoHandle: item.undoHandle,
      applyMode: item.applyMode,
    };
    if (item.status === "accepted") {
      // Reverting an accept must undo whatever the accept applied.
      //
      // Tracked-changes accepts carry `revisionIds`: reject those specific
      // marks by id (`rejectAIEditOperation`), which is position-independent
      // and works no matter what else changed in the document since. This
      // replaces `undoDocumentOperations`, a strict LIFO/exact-doc-match undo
      // that rejected ("Action failed") after any later edit — a second
      // accept, manual typing, or resolving the change through the Word review
      // controls — i.e. exactly when an out-of-order revert is most wanted.
      //
      // Direct-mode accepts leave no tracked marks (`revisionIds === null`);
      // there the stack undo is still the only lever, so fall back to it.
      if (item.revisionIds !== null) {
        const rejected = docxEditorRef.current?.rejectAIEditOperation(
          item.revisionIds,
        );
        if (rejected !== true) {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
          return;
        }
      } else if (item.undoHandle !== null) {
        const undoResult = docxEditorRef.current?.undoDocumentOperations(
          item.undoHandle,
        );
        if (undoResult?.status !== "undone") {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
          return;
        }
      }
    }
    updateSuggestion(entityId, item.id, {
      status: "pending",
      revisionIds: null,
      undoHandle: null,
      applyMode: null,
      skipReason: undefined,
    });
    if (item.persisted !== true) {
      return;
    }
    detached(
      (async () => {
        const result = await runSerialized(
          item.id,
          async () =>
            await revertDocxSuggestionRequest({
              workspaceId,
              entityId,
              suggestionId: item.id,
            }),
        );
        // "stale" means the server row was still pending — the same state we
        // just moved the local suggestion to, so nothing to reconcile and no
        // toast. "synced" is the happy path.
        if (result === "synced" || result === "stale") {
          return;
        }
        // "failed": the server row is still terminal, but the local revert
        // already ran. Restore the prior resolution so they agree again.
        captureResolveFailure("revert");
        if (prev.status === "accepted") {
          // Re-apply to restore the accepted change with fresh identifiers:
          // the local revert already removed it (the tracked marks were
          // rejected, or the direct-mode undo handle was consumed), so the old
          // revisionIds / undoHandle no longer resolve.
          const outcome = applyPending(item);
          recordOutcome(item, outcome);
        } else {
          updateSuggestion(entityId, item.id, {
            status: prev.status,
            revisionIds: prev.revisionIds,
            undoHandle: prev.undoHandle,
            applyMode: prev.applyMode,
          });
        }
        toastPersistFailed();
      })(),
      "useReviewActions",
    );
  });

  const acceptMany = useLatestCallback(
    async (items: readonly ReviewSuggestion[]) => {
      // Cheap gate off the LIVE store: only prompt to unlock if something is
      // still pending. The authoritative per-item claim happens in the loop
      // below, after the unlock await.
      const anyPending = items.some(
        (item) => readLive(item.id)?.status === "pending",
      );
      if (!anyPending) {
        return;
      }
      const unlocked = await ensureUnlocked();
      if (!unlocked) {
        return;
      }
      // The API has no batch-resolve, so persist per accepted+persisted
      // item after the local batch apply. Each item's resolve result drives
      // its own rollback; a single toast at most covers the whole batch.
      const toPersist: { item: ReviewSuggestion; outcome: ApplyOutcome }[] = [];
      for (const item of items) {
        // Claim each target from the LIVE store as we reach it: the captured
        // array is stale after the unlock await (a concurrent Accept-all from
        // the other surface, or a single accept/reject, may have resolved some;
        // the create response may have reconciled ids). Claiming pending ->
        // applying atomically here means an operation is applied at most once
        // even when both surfaces trigger Accept-all before either state update
        // is observed.
        const claimed = claimPending(item.id, "applying");
        if (claimed === null) {
          continue;
        }
        const outcome = applyPending(claimed);
        recordOutcome(claimed, outcome);
        if (claimed.persisted === true && outcome.status === "accepted") {
          toPersist.push({ item: claimed, outcome });
        }
      }
      if (toPersist.length === 0) {
        return;
      }
      detached(
        (async () => {
          const results = await Promise.all(
            toPersist.map(async ({ item, outcome }) => {
              const result = await runSerialized(
                item.id,
                async () =>
                  await resolveDocxSuggestionRequest({
                    workspaceId,
                    entityId,
                    suggestionId: item.id,
                    status: "accepted",
                    appliedMode: applyMode,
                  }),
              );
              if (result === "synced") {
                return result;
              }
              rollbackAcceptedResolution(item, outcome.undoHandle, result);
              return result;
            }),
          );
          surfaceBatchResolveToast(results);
        })(),
        "useReviewActions",
      );
    },
  );

  const rejectMany = useLatestCallback((items: readonly ReviewSuggestion[]) => {
    // Resolve each captured item to its LIVE row (following any reconcile
    // rename) and keep only those still pending. rejectMany has no await before
    // the batch set, so this read + `setStatusBatch` runs as one synchronous
    // block that no other handler can interleave: collecting the still-pending
    // rows and flipping them is atomic, and a target another handler already
    // resolved is dropped rather than re-rejected.
    const targets = items
      .map((item) => readLive(item.id))
      .filter(
        (row): row is ReviewSuggestion =>
          row !== undefined && row.status === "pending",
      );
    if (targets.length === 0) {
      return;
    }
    setStatusBatch(
      entityId,
      targets.map((item) => item.id),
      "rejected",
    );
    const toPersist = targets.filter((item) => item.persisted === true);
    if (toPersist.length === 0) {
      return;
    }
    detached(
      (async () => {
        const results = await Promise.all(
          toPersist.map(async (item) => {
            const result = await runSerialized(
              item.id,
              async () =>
                await resolveDocxSuggestionRequest({
                  workspaceId,
                  entityId,
                  suggestionId: item.id,
                  status: "rejected",
                  appliedMode: null,
                }),
            );
            if (result === "synced") {
              return result;
            }
            rollbackRejectedResolution(item, result);
            return result;
          }),
        );
        surfaceBatchResolveToast(results);
      })(),
      "useReviewActions",
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

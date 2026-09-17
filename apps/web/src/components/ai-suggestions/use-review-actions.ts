/**
 * useReviewActions — the single owner of accept / reject / revert /
 * batch / navigate behaviour for AI DOCX suggestions.
 *
 * Both the inspector's document-review facet and the floating ReviewBar consume
 * this hook, so the two surfaces resolve a change the exact same way (apply
 * the tracked-change ops, record the outcome on the store, keep
 * `pendingOperation` for a later revert) and can never drift.
 *
 * Every action takes a review change: one suggestion, or a run of chat
 * deletions the reviewer decides as one. A change's members are claimed,
 * applied, rolled back and reverted together; the store and the server keep
 * one row per member.
 */

import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { DocxEditorRef, FolioAIEditApplyMode } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/toast";

import {
  resolveDocxSuggestionRequest,
  revertDocxSuggestionRequest,
} from "@/components/ai-suggestions/docx-suggestion-persistence";
import type {
  ReviewChange,
  ReviewChangeMembers,
} from "@/components/ai-suggestions/review-bar.logic";
import {
  mapReviewChangeMembers,
  reviewChangeStatus,
} from "@/components/ai-suggestions/review-bar.logic";
import {
  applyReviewChange,
  skipEveryMember,
  undoAcceptedMembers,
} from "@/components/ai-suggestions/review-change-apply.logic";
import type {
  ApplyOutcome,
  MemberApplyOutcomes,
} from "@/components/ai-suggestions/review-change-apply.logic";
import { settleChangeResolutions } from "@/components/ai-suggestions/review-change-resolution.logic";
import type {
  DocxWriteResult,
  MemberResolution,
} from "@/components/ai-suggestions/review-change-resolution.logic";
import { findFolioReviewDecoration } from "@/components/ai-suggestions/review-folio-decorations";
import {
  serializeSuggestionWrite,
  trackReviewSessionWrite,
} from "@/components/ai-suggestions/review-session-writes";
import {
  findLiveSuggestion,
  getReviewApplyMode,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type {
  ReviewSuggestion,
  ReviewSuggestionStatus,
} from "@/components/ai-suggestions/review-store";
import type { DocxEditModeResult } from "@/components/docx/docx-browser-editor.logic";
import { getWordEditAuthorName } from "@/features/chat/hooks/use-chat-user-context";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";

export type UseReviewActionsOptions = {
  entityId: string;
  persistence: { type: "local" } | { type: "workspace"; workspaceId: string };
  docxEditorRef: RefObject<DocxEditorRef | null>;
  /** Whether the editor currently accepts edit operations. */
  docxEditable: boolean;
  /**
   * Prompt the user to unlock the document. Resolves to the edit-mode
   * outcome, which carries why a request was blocked. Called before an
   * apply while the editor is locked.
   */
  requestDocxEditMode?: (() => Promise<DocxEditModeResult>) | undefined;
};

export type ReviewActions = {
  applyMode: FolioAIEditApplyMode;
  setApplyMode: (mode: FolioAIEditApplyMode) => void;
  /** Apply a pending change as tracked changes (or direct), all or nothing. */
  acceptChange: (change: ReviewChange) => Promise<void>;
  /** Reject a pending change (kept revertible). */
  rejectChange: (change: ReviewChange) => void;
  /** Put an accepted / rejected / skipped change back into the pending queue. */
  revertChange: (change: ReviewChange) => void;
  /** Accept every pending change in `changes`, in order. */
  acceptAll: (changes: readonly ReviewChange[]) => Promise<void>;
  /** Focus a change and scroll the document to it. */
  navigateTo: (change: ReviewChange) => void;
};

type PersistChangeOptions = {
  context: "accept" | "reject" | "revert";
  resolutions: readonly MemberResolution[];
  /** Restore the whole change locally after the server refused a member. */
  rollback: () => void;
};

export const useReviewActions = ({
  entityId,
  persistence,
  docxEditorRef,
  docxEditable,
  requestDocxEditMode,
}: UseReviewActionsOptions): ReviewActions => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const applyMode = useReviewStore((state) =>
    getReviewApplyMode(state, entityId),
  );
  const updateSuggestion = useReviewStore((state) => state.updateSuggestion);
  const setApplyModeAction = useReviewStore((state) => state.setApplyMode);
  const setFocusedId = useReviewStore((state) => state.setFocusedId);
  // Author the tracked-change marks as the user (their preferred name
  // from account settings): they are accepting the AI's suggestion AS
  // THEMSELVES, not as "AI".
  const user = useAuthenticatedUser();
  const wordAuthor = getWordEditAuthorName(user);
  const persistedWorkspaceId = useLatestCallback(() => {
    if (persistence.type === "local") {
      return panic("A local DOCX suggestion cannot be persisted");
    }
    return persistence.workspaceId;
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
    return (await requestDocxEditMode()).type === "editing";
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

  // The live rows of a change's members, when every one is in `status`.
  const readLiveMembers = useLatestCallback(
    (
      change: ReviewChange,
      status: ReviewSuggestionStatus,
    ): ReviewChangeMembers | null => {
      const live = mapReviewChangeMembers(change.members, (member) =>
        readLive(member.id),
      );
      const [first, ...rest] = live;
      if (first?.status !== status) {
        return null;
      }
      const others = rest.filter(
        (row): row is ReviewSuggestion => row?.status === status,
      );
      return others.length === rest.length ? [first, ...others] : null;
    },
  );

  // Atomically claim a still-pending change from the LIVE store, flipping every
  // member to `claimStatus`. Returns the claimed rows (the caller now owns
  // them) or null when any member was already non-pending — a concurrent
  // double-click, or an Accept-all fired from the other surface, already
  // claimed it. The read-check-set runs synchronously with no await between,
  // so only one caller can win the claim.
  const claimChange = useLatestCallback(
    (
      change: ReviewChange,
      claimStatus: ReviewSuggestionStatus,
    ): ReviewChangeMembers | null => {
      const claimed = readLiveMembers(change, "pending");
      if (claimed === null) {
        return null;
      }
      for (const row of claimed) {
        updateSuggestion(entityId, row.id, { status: claimStatus });
      }
      return claimed;
    },
  );

  // Release a claim back to pending, following any reconcile rename that
  // happened while the claim was held. Only rows still holding the claim move,
  // so a member another handler resolved in the meantime keeps its outcome.
  const releaseClaim = useLatestCallback(
    (
      members: readonly ReviewSuggestion[],
      claimStatus: ReviewSuggestionStatus,
    ) => {
      for (const member of members) {
        const live = readLive(member.id);
        if (live?.status === claimStatus) {
          updateSuggestion(entityId, live.id, { status: "pending" });
        }
      }
    },
  );

  type RejectStagedSuggestionResult =
    | { status: "not-staged" }
    | { status: "rejected" }
    | { status: "failed" };

  const rejectStagedSuggestion = useLatestCallback(
    (item: ReviewSuggestion): RejectStagedSuggestionResult => {
      const editor = docxEditorRef.current;
      const suggestionId = item.pendingOperation?.id;
      const staged = editor
        ?.getSuggestions()
        .some((suggestion) => suggestion.suggestionId === suggestionId);
      if (!(editor && suggestionId && staged)) {
        return { status: "not-staged" };
      }
      return editor.rejectSuggestion(suggestionId)
        ? { status: "rejected" }
        : { status: "failed" };
    },
  );

  /**
   * Apply a change's operations with the editor. A staged single suggestion
   * is resolved in place: accepting Folio's own suggestion keeps its tracked
   * marks. Anything else goes through one document-operation batch, with any
   * staged member taken out of suggested mode first so the batch does not
   * apply it a second time.
   */
  const applyMembers = useLatestCallback(
    (
      members: ReviewChangeMembers,
      applyModeOverride?: FolioAIEditApplyMode,
    ): MemberApplyOutcomes => {
      // Default to the currently selected mode; the revert-recovery path passes
      // the mode the change was originally accepted with so a re-apply can't
      // silently switch tracked-changes ↔ direct.
      const mode = applyModeOverride ?? applyMode;
      const editor = docxEditorRef.current;
      if (!editor) {
        return skipEveryMember(members, mode, "documentNotEditable");
      }
      const [only, ...rest] = members;
      const suggestionId = only.pendingOperation?.id;
      const staged =
        rest.length === 0 && suggestionId !== undefined
          ? editor
              .getSuggestions()
              .find((suggestion) => suggestion.suggestionId === suggestionId)
          : undefined;
      if (
        suggestionId !== undefined &&
        staged !== undefined &&
        mode === "tracked-changes" &&
        staged.appliedAs === "tracked" &&
        only.revisionIds !== null
      ) {
        const accepted = editor.acceptSuggestion(suggestionId, {
          ...(wordAuthor.length > 0 && { author: wordAuthor }),
        });
        const outcome: ApplyOutcome = accepted.accepted
          ? {
              status: "accepted",
              revisionIds: only.revisionIds,
              undoHandle: null,
              appliedMode: "tracked-changes",
            }
          : {
              status: "skipped",
              revisionIds: null,
              undoHandle: null,
              appliedMode: mode,
              skipReason: "unsupportedBlock",
            };
        return [{ member: only, outcome }];
      }

      for (const member of members) {
        if (rejectStagedSuggestion(member).status === "failed") {
          return skipEveryMember(members, mode, "unsupportedBlock");
        }
      }
      return applyReviewChange({
        editor,
        members,
        mode,
        author: wordAuthor,
      });
    },
  );

  const recordOutcomes = useLatestCallback((outcomes: MemberApplyOutcomes) => {
    // Keep `pendingOperation` even after a successful accept so a later
    // "Revert" can put the suggestion back into review without losing
    // the original operation spec. The lifecycle's source of truth is
    // `status`, not the presence of `pendingOperation`.
    for (const { member, outcome } of outcomes) {
      updateSuggestion(entityId, member.id, {
        status: outcome.status,
        revisionIds: outcome.revisionIds,
        undoHandle: outcome.undoHandle,
        applyMode: outcome.status === "accepted" ? outcome.appliedMode : null,
        ...(outcome.skipReason !== undefined && {
          skipReason: outcome.skipReason,
        }),
      });
    }
  });

  // --- Persistence (audit trail) -----------------------------------------
  //
  // Only `persisted` suggestions (a server row exists) hit the server.
  // A server disagreement reconciles local/editor state so the two can never
  // permanently diverge:
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
      task: () => Promise<DocxWriteResult>,
    ): Promise<DocxWriteResult> =>
      await serializeSuggestionWrite({
        reviewSessionId: entityId,
        suggestionId: id,
        write: task,
      }),
  );

  const captureResolveFailure = (context: PersistChangeOptions["context"]) => {
    getAnalytics().captureError(
      new Error(`DOCX suggestion ${context} failed to persist`),
    );
  };

  // Surface at most one toast for a batch of resolve results, preferring
  // the transport failure over a stale-row reconcile.
  const surfaceBatchResolveToast = useLatestCallback(
    (results: readonly DocxWriteResult[]) => {
      if (results.includes("failed")) {
        stellaToast.add({
          title: t("docxReview.persistFailed"),
          type: "error",
        });
        return;
      }
      if (results.includes("pending-limit")) {
        stellaToast.add({
          title: t("docxReview.pendingLimitReached"),
          type: "error",
        });
        return;
      }
      if (results.includes("stale")) {
        stellaToast.add({
          title: t("docxReview.staleResolution"),
          type: "warning",
        });
      }
    },
  );

  /**
   * Write one change's resolution to the server, one request per persisted
   * member, in parallel. A change is one decision, so a member the server did
   * not take rolls the whole change back: locally through `rollback`, and on
   * the server by undoing the members that did sync. Returns every result for
   * the caller's single toast.
   */
  const persistChange = useLatestCallback(
    async ({
      context,
      resolutions,
      rollback,
    }: PersistChangeOptions): Promise<readonly DocxWriteResult[]> => {
      const { results, undone } = await settleChangeResolutions({
        resolutions,
        standing: ["synced"],
        rollback,
        run: async (member, write) => await runSerialized(member.id, write),
      });
      if (results.includes("failed") || undone.includes("failed")) {
        captureResolveFailure(context);
      }
      return [
        ...results,
        ...undone.filter(
          (result) => result === "failed" || result === "pending-limit",
        ),
      ];
    },
  );

  const revertRequest = (member: ReviewSuggestion) => async () =>
    await revertDocxSuggestionRequest({
      queryClient,
      workspaceId: persistedWorkspaceId(),
      entityId,
      suggestion: member,
    });

  // Undo the editor ops an accept landed and put every member back to pending.
  const rollbackAcceptedChange = useLatestCallback(
    (outcomes: MemberApplyOutcomes) => {
      undoAcceptedMembers(
        docxEditorRef.current,
        outcomes.map(({ outcome }) => outcome),
      );
      for (const { member } of outcomes) {
        updateSuggestion(entityId, member.id, {
          status: "pending",
          revisionIds: null,
          undoHandle: null,
          applyMode: null,
        });
      }
    },
  );

  // Persist an accept that landed. A skipped apply leaves the rows pending
  // server-side so they can be retried.
  const persistAccepted = useLatestCallback(
    async (
      outcomes: MemberApplyOutcomes,
    ): Promise<readonly DocxWriteResult[]> => {
      if (outcomes.some(({ outcome }) => outcome.status !== "accepted")) {
        return [];
      }
      const resolutions = outcomes
        .filter(({ member }) => member.persisted === true)
        .map(({ member, outcome }): MemberResolution => ({
          member,
          resolve: async () =>
            await resolveDocxSuggestionRequest({
              queryClient,
              workspaceId: persistedWorkspaceId(),
              entityId,
              suggestionId: member.id,
              status: "accepted",
              appliedMode: outcome.appliedMode,
            }),
          undo: revertRequest(member),
        }));
      if (resolutions.length === 0) {
        return [];
      }
      return await persistChange({
        context: "accept",
        resolutions,
        rollback: () => rollbackAcceptedChange(outcomes),
      });
    },
  );

  const acceptChange = useLatestCallback(async (change: ReviewChange) => {
    // Claim synchronously from the LIVE store, not the render-time snapshot:
    // a rapid double-click fires two accepts that both captured a "pending"
    // change, so checking the captured status lets both through.
    // `claimChange` reads the current status and flips it to "applying"
    // before any await, so only the first proceeds.
    if (claimChange(change, "applying") === null) {
      return;
    }
    // The claimed rows stay "applying" across the unlock and paint awaits
    // below. Tracking that window makes a session reset wait until the accept
    // lands or releases its claim.
    await trackReviewSessionWrite(
      entityId,
      (async () => {
        const unlocked = await ensureUnlocked();
        if (!unlocked) {
          // Release the claim so a cancelled unlock leaves the card actionable.
          releaseClaim(change.members, "applying");
          return;
        }
        // Yield to the macrotask queue so the "applying" status can paint before
        // the synchronous editor apply.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        // Re-read the LIVE rows: the background persist can land in the unlock/paint
        // gap and `reconcileServerIds` renames rows (client ref -> server id) and
        // flips `persisted` true. Driving the outcome + the resolve off the
        // captured members would write to stale client ids (a no-op after the
        // rename), stranding rows "applying" while the server stays pending.
        const live = readLiveMembers(change, "applying");
        if (live === null) {
          // Part of the claim was lost (a reconcile collapse dropped a row, or
          // another handler took it over). Apply nothing and hand back the rest.
          releaseClaim(change.members, "applying");
          return;
        }
        const outcomes = applyMembers(live);
        recordOutcomes(outcomes);
        detached(
          trackReviewSessionWrite(
            entityId,
            (async () => {
              surfaceBatchResolveToast(await persistAccepted(outcomes));
            })(),
          ),
          "use-review-actions.persist-accept",
        );
      })(),
    );
  });

  const acceptAll = useLatestCallback(
    async (changes: readonly ReviewChange[]) => {
      // Cheap gate off the LIVE store: only prompt to unlock if something is
      // still pending. The authoritative per-change claim happens in the loop
      // below, after the unlock await.
      if (
        !changes.some((change) => readLiveMembers(change, "pending") !== null)
      ) {
        return;
      }
      const unlocked = await ensureUnlocked();
      if (!unlocked) {
        return;
      }
      const persisting: Promise<readonly DocxWriteResult[]>[] = [];
      for (const change of changes) {
        // Claim each change from the LIVE store as we reach it: the captured
        // array is stale after the unlock await (a concurrent Accept-all from
        // the other surface, or a single accept/reject, may have resolved some;
        // the create response may have reconciled ids). Claiming pending ->
        // applying atomically here means an operation is applied at most once
        // even when both surfaces trigger Accept-all before either state update
        // is observed.
        const claimed = claimChange(change, "applying");
        if (claimed === null) {
          continue;
        }
        const outcomes = applyMembers(claimed);
        recordOutcomes(outcomes);
        persisting.push(persistAccepted(outcomes));
      }
      if (persisting.length === 0) {
        return;
      }
      detached(
        trackReviewSessionWrite(
          entityId,
          (async () => {
            surfaceBatchResolveToast((await Promise.all(persisting)).flat());
          })(),
        ),
        "use-review-actions.persist-accept-all",
      );
    },
  );

  const rejectChange = useLatestCallback((change: ReviewChange) => {
    // Claim from the LIVE store, same as accept: a rapid double-click fires two
    // rejects that both captured a "pending" change. Without the claim the
    // second call enqueues a resolve that comes back "stale" and the rollback
    // flips the shared card back to pending while the server row stays
    // rejected.
    const claimed = claimChange(change, "rejected");
    if (claimed === null) {
      return;
    }
    const unstaged = claimed.map((member) => ({
      member,
      rejected: rejectStagedSuggestion(member),
    }));
    if (unstaged.some(({ rejected }) => rejected.status === "failed")) {
      // The staging bridge re-stages any member already taken out of
      // suggested mode once it is pending again.
      releaseClaim(claimed, "rejected");
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    for (const { member, rejected } of unstaged) {
      if (rejected.status === "rejected") {
        updateSuggestion(entityId, member.id, {
          revisionIds: null,
          undoHandle: null,
          applyMode: null,
        });
      }
    }
    // Same reason as accept: don't drop pendingOperation, so the user can
    // revert the rejection and the change goes back to actionable.
    const resolutions = claimed
      .filter((member) => member.persisted === true)
      .map((member): MemberResolution => ({
        member,
        resolve: async () =>
          await resolveDocxSuggestionRequest({
            queryClient,
            workspaceId: persistedWorkspaceId(),
            entityId,
            suggestionId: member.id,
            status: "rejected",
            appliedMode: null,
          }),
        undo: revertRequest(member),
      }));
    if (resolutions.length === 0) {
      return;
    }
    detached(
      trackReviewSessionWrite(
        entityId,
        (async () => {
          surfaceBatchResolveToast(
            await persistChange({
              context: "reject",
              resolutions,
              rollback: () => {
                for (const member of claimed) {
                  updateSuggestion(entityId, member.id, { status: "pending" });
                }
              },
            }),
          );
        })(),
      ),
      "use-review-actions.persist-reject",
    );
  });

  const revertChange = useLatestCallback((change: ReviewChange) => {
    const status = reviewChangeStatus(change);
    if (status === "pending") {
      return;
    }
    const { members } = change;
    // Snapshot the pre-revert resolution so a persist failure can put the
    // change back exactly where it was (server stays terminal, so the editor
    // must too).
    const previous = members.map((member) => ({
      member,
      status: member.status,
      revisionIds: member.revisionIds,
      undoHandle: member.undoHandle,
      applyMode: member.applyMode,
    }));
    // Reverting an accept must undo whatever the accept applied. Rejecting the
    // tracked marks by id works after later edits, where a strict stack undo
    // would refuse exactly when an out-of-order revert is most wanted.
    if (
      status === "accepted" &&
      !undoAcceptedMembers(docxEditorRef.current, members)
    ) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    for (const member of members) {
      updateSuggestion(entityId, member.id, {
        status: "pending",
        revisionIds: null,
        undoHandle: null,
        applyMode: null,
        skipReason: undefined,
      });
    }

    const resolutions = previous
      .filter(({ member }) => member.persisted === true)
      .map(
        ({
          member,
          status: previousStatus,
          applyMode: previousMode,
        }): MemberResolution => ({
          member,
          resolve: revertRequest(member),
          undo: async () =>
            previousStatus === "accepted" || previousStatus === "rejected"
              ? await resolveDocxSuggestionRequest({
                  queryClient,
                  workspaceId: persistedWorkspaceId(),
                  entityId,
                  suggestionId: member.id,
                  status: previousStatus,
                  appliedMode:
                    previousStatus === "accepted"
                      ? (previousMode ?? "tracked-changes")
                      : null,
                })
              : "synced",
        }),
      );
    if (resolutions.length === 0) {
      return;
    }
    detached(
      trackReviewSessionWrite(
        entityId,
        (async () => {
          const settled = await Promise.all(
            resolutions.map(async (resolution) => ({
              resolution,
              result: await runSerialized(
                resolution.member.id,
                resolution.resolve,
              ),
            })),
          );
          // "stale" means the server row was still pending — the same state we
          // just moved the local change to, so nothing to reconcile and no
          // toast.
          const revertResults = settled.map(({ result }) => result);
          if (
            revertResults.every(
              (result) => result === "synced" || result === "stale",
            )
          ) {
            return;
          }
          // A failed write, or the document at its pending cap, leaves a server row
          // terminal. The cap is an expected refusal, not a failure to capture.
          if (revertResults.includes("failed")) {
            captureResolveFailure("revert");
          }
          surfaceBatchResolveToast(revertResults);
          // Restore the whole change, then put the members whose revert did
          // land back into their terminal state on the server too.
          const restored = (() => {
            if (status !== "accepted") {
              for (const entry of previous) {
                updateSuggestion(entityId, entry.member.id, {
                  status: entry.status,
                  revisionIds: entry.revisionIds,
                  undoHandle: entry.undoHandle,
                  applyMode: entry.applyMode,
                });
              }
              return true;
            }
            // Re-apply to restore the accepted change with fresh identifiers:
            // the local revert already removed it, so the old revisionIds /
            // undoHandle no longer resolve. Restore with the mode it was
            // ORIGINALLY accepted under, not whatever the picker shows now.
            // The live rows are read again: while the revert was in flight the
            // staging bridge may have re-staged them.
            const live = readLiveMembers(change, "pending");
            if (live === null) {
              return false;
            }
            const outcomes = applyMembers(
              live,
              members[0].applyMode ?? undefined,
            );
            recordOutcomes(outcomes);
            return outcomes.every(
              ({ outcome }) => outcome.status === "accepted",
            );
          })();
          if (!restored) {
            return;
          }
          const undone = await Promise.all(
            settled
              .filter(({ result }) => result === "synced")
              .map(
                async ({ resolution }) =>
                  await runSerialized(resolution.member.id, resolution.undo),
              ),
          );
          if (undone.includes("failed")) {
            captureResolveFailure("revert");
          }
        })(),
      ),
      "use-review-actions.persist-revert",
    );
  });

  const navigateTo = useLatestCallback((change: ReviewChange) => {
    const [item] = change.members;
    setFocusedId(entityId, item.id);
    const suggestionId = item.pendingOperation?.id;
    if (
      suggestionId !== undefined &&
      docxEditorRef.current?.scrollToSuggestion(suggestionId) === true
    ) {
      return;
    }
    // Pending items don't have revision ids yet (nothing applied), so
    // scroll by the snapshot blockId. Once accepted in tracked-changes
    // mode the revision-ids path snaps to the exact insertion/deletion
    // marks instead.
    if (item.revisionIds !== null) {
      docxEditorRef.current?.scrollToAIEditOperation(item.revisionIds);
      return;
    }
    const pagedEditor = docxEditorRef.current?.getEditorRef();
    const view = pagedEditor?.getView();
    if (pagedEditor && view) {
      const decoration = findFolioReviewDecoration(item, view.state.doc);
      if (decoration !== null) {
        pagedEditor.setSelection(decoration.range.from);
        pagedEditor.scrollToPosition(decoration.range.from);
        return;
      }
    }
    docxEditorRef.current?.scrollToBlock(
      item.blockId,
      item.snapshot ?? undefined,
    );
  });

  return {
    applyMode,
    setApplyMode,
    acceptChange,
    rejectChange,
    revertChange,
    acceptAll,
    navigateTo,
  };
};

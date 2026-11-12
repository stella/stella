import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import {
  predictBulkReviewed,
  predictClaimReview,
  withClaimReviews,
} from "@/features/avt/claim-review.logic";
import { avtKeys, verificationRunOptions } from "@/features/avt/queries";
import type { SaveState } from "@/features/avt/save-state.logic";
import { readTargetIds, saveStateOf } from "@/features/avt/save-state.logic";
import type {
  ClaimReview,
  ClaimReviewEvent,
  VerificationClaim,
} from "@/features/avt/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import { useObservedMutationState } from "@/lib/idempotency/use-observed-mutation-state";
import { toSafeId } from "@/lib/safe-id";

type ClaimId = VerificationClaim["id"];

type RunScope = {
  workspaceId: string;
  runId: string;
};

const claimReviewMutationKey = ({ workspaceId, runId }: RunScope) =>
  ["avt", workspaceId, "claim-reviews", runId] as const;

type RecordVariables = { targetIds: [ClaimId]; event: ClaimReviewEvent };
type BulkVariables = { targetIds: ClaimId[] };

/**
 * Whether a recorded event changes the qualifiers the server reads for the
 * claim. Governing a record conflict moves the verdict onto the chosen fact,
 * whose standing (no source, held) the claim then carries, so the run is
 * read again; every other event leaves what the verdict rests on alone.
 */
const QUALIFIER_READ_AFTER = {
  status: "kept",
  override: "kept",
  note: "kept",
  reopen: "kept",
  "record-conflict": "reread",
  "fact-link": "kept",
} as const satisfies Record<ClaimReviewEvent["kind"], "kept" | "reread">;

type PreviousReviews = {
  previous: { claimId: ClaimId; review: ClaimReview | null }[];
};

/**
 * Reviewer actions on one verification run. Each action is its own POST:
 * the claim shows the predicted review at once, the server's review replaces
 * it on success, and a failure restores what the claim had before and says
 * so in a toast.
 */
export const useClaimReviewActions = (scope: RunScope) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const actorId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });
  const runKey = verificationRunOptions(
    scope.workspaceId,
    scope.runId,
  ).queryKey;
  // Every recorded action is a new history entry, whichever view lists it.
  const refreshHistory = async () =>
    await queryClient.invalidateQueries({
      queryKey: avtKeys.reviewHistoryOfRun(scope.workspaceId, scope.runId),
    });
  const mutationKey = claimReviewMutationKey(scope);
  const lists = () =>
    api.lists({ workspaceId: toSafeId<"workspace">(scope.workspaceId) });
  const runId = toSafeId<"legalListVerificationRun">(scope.runId);

  const applyOptimistic = async (
    claimIds: readonly ClaimId[],
    predict: (review: ClaimReview | null) => ClaimReview,
  ): Promise<PreviousReviews> => {
    await queryClient.cancelQueries({ queryKey: runKey });
    const run = queryClient.getQueryData(runKey);
    // Nothing cached yet: no optimistic state to write or roll back.
    const previous = (run === undefined ? [] : run.claims)
      .filter((claim) => claimIds.includes(claim.id))
      .map((claim) => ({ claimId: claim.id, review: claim.review }));
    queryClient.setQueryData(runKey, (current) =>
      current === undefined
        ? current
        : withClaimReviews(
            current,
            previous.map(({ claimId, review }) => ({
              claimId,
              review: predict(review),
            })),
          ),
    );
    return { previous };
  };

  const rollback = (error: Error, context: PreviousReviews | undefined) => {
    if (context !== undefined) {
      queryClient.setQueryData(runKey, (current) =>
        current === undefined
          ? current
          : withClaimReviews(current, context.previous),
      );
    }
    analytics.captureError(error, {
      fingerprintKey: "useClaimReviewActions.rollback:failure",
      scope: {
        type: "handler",
        handlerId: "useClaimReviewActions.rollback:failure",
      },
    });
    notifyUserError(error, t("avt.save.failedTitle"));
  };

  const now = () => Temporal.Now.instant().toString();

  const record = useIdempotentMutation({
    mutationKey,
    // A run's review actions reach the server in the order they were taken.
    scope: { id: mutationKey.join(":") },
    mutationFn: async (
      { targetIds: [claimId], event }: RecordVariables,
      request,
    ) =>
      unwrapApiResponse(
        await lists()["claim-reviews"].post({ runId, claimId, event }, request),
      ),
    onMutate: async ({ targetIds, event }) =>
      await applyOptimistic(targetIds, (review) =>
        predictClaimReview(review, event, { at: now(), actorId }),
      ),
    onSuccess: async ({ claimId, review }, { event }) => {
      queryClient.setQueryData(runKey, (current) =>
        current === undefined
          ? current
          : withClaimReviews(current, [{ claimId, review }]),
      );
      if (QUALIFIER_READ_AFTER[event.kind] === "reread") {
        await queryClient.invalidateQueries({ queryKey: runKey });
      }
      await refreshHistory();
    },
    onError: (error, _variables, context) => rollback(error, context),
  });

  const bulk = useIdempotentMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: async ({ targetIds: claimIds }: BulkVariables, request) =>
      unwrapApiResponse(
        await lists()["claim-reviews"].bulk.post({ runId, claimIds }, request),
      ),
    onMutate: async ({ targetIds }) =>
      await applyOptimistic(targetIds, (review) =>
        predictBulkReviewed(review, { at: now(), actorId }),
      ),
    onSuccess: ({ reviews }) => {
      queryClient.setQueryData(runKey, (current) =>
        current === undefined ? current : withClaimReviews(current, reviews),
      );
    },
    onError: (error, _variables, context) => rollback(error, context),
    // The answer names only the claims it marked; a claim someone else
    // decided meanwhile keeps its predicted review until the run is read
    // again, so the server's fold replaces every prediction.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: runKey });
      await refreshHistory();
    },
  });

  return {
    recordEvent: (claimId: ClaimId, event: ClaimReviewEvent) => {
      record.mutate({ targetIds: [claimId], event });
    },
    acceptRoutine: (claimIds: ClaimId[]) => {
      if (claimIds.length === 0) {
        return;
      }
      bulk.mutate({ targetIds: claimIds });
    },
  };
};

/** The save indicator for one claim, derived from this run's review POSTs. */
export const useClaimSaveState = (
  scope: RunScope,
  claimId: ClaimId,
): SaveState => {
  const entries = useObservedMutationState({
    filters: { mutationKey: claimReviewMutationKey(scope) },
    select: (state) => ({
      targetIds: readTargetIds(state.variables),
      status: state.status,
    }),
  });
  return saveStateOf(entries, claimId);
};

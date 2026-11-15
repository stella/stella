import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import {
  predictBulkReviewed,
  predictClaimReview,
  withClaimReviews,
} from "@/features/avt/claim-review.logic";
import { verificationRunOptions } from "@/features/avt/queries";
import type { SaveState } from "@/features/avt/save-state.logic";
import { readTargetIds, saveStateOf } from "@/features/avt/save-state.logic";
import type {
  ClaimReview,
  ClaimReviewEvent,
  VerificationClaim,
} from "@/features/avt/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
import { useObservedMutationState } from "@/lib/idempotency/use-observed-mutation-state";
import { toSafeId } from "@/lib/safe-id";
import { resourceMutation } from "@/lib/workspace-realtime";
import { runWorkspaceMutation } from "@/lib/workspaces/workspace-mutation";

type ClaimId = VerificationClaim["id"];

type RunScope = {
  workspaceId: string;
  runId: string;
};

const claimReviewMutationKey = ({ workspaceId, runId }: RunScope) =>
  ["avt", workspaceId, "claim-reviews", runId] as const;

type RecordVariables = {
  workspaceId: string;
  targetIds: [ClaimId];
  event: ClaimReviewEvent;
};
type BulkVariables = { workspaceId: string; targetIds: ClaimId[] };

/**
 * Whether a recorded event changes what the server reads for the claim: its
 * qualifiers, or whether it needs attention. Governing a record conflict
 * moves the verdict onto the chosen fact, whose standing (no source, held)
 * the claim then carries, and reopening a set-aside claim makes it checkable,
 * so the run is read again; every other event leaves both alone.
 */
const QUALIFIER_READ_AFTER = {
  status: "kept",
  override: "kept",
  note: "kept",
  reopen: "reread",
  "record-conflict": "reread",
  "fact-link": "kept",
} as const satisfies Record<ClaimReviewEvent["kind"], "kept" | "reread">;

/**
 * The server's answer to a correlated review request. A refused request
 * keeps its own error, so the toast, the step-up and the session handling
 * read the API's answer rather than the correlation wrapper.
 */
const answerOf = <T>(sent: Result<T, Error & { cause: unknown }>): T =>
  readQueryResult(
    Result.isError(sent) && sent.error.cause instanceof Error
      ? Result.err(sent.error.cause)
      : sent,
  );

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
  const mutationKey = claimReviewMutationKey(scope);
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

  const recordReview = resourceMutation({
    mutation: "recordClaimReview",
    queryClient,
    mutationFn: async (
      { workspaceId: matterId, targetIds: [claimId], event }: RecordVariables,
      request: IdempotentRequest,
    ) => {
      const workspaceId = toSafeId<"workspace">(matterId);
      return answerOf(
        // Correlated, so this client consumes its own realtime echo: it
        // already wrote the claim's review into the run and refreshed what
        // the contract names.
        await runWorkspaceMutation({
          client: queryClient,
          request: async (mutationId) =>
            await invokeCapability(
              "lists.verifications.claim-reviews.create",
              async (declared) =>
                unwrapApiResponse(
                  await api.lists({ workspaceId })["claim-reviews"].post(
                    { runId, claimId, event },
                    {
                      ...declared,
                      headers: {
                        "Idempotency-Key": request.headers["Idempotency-Key"],
                        "x-stella-mutation-id": mutationId,
                        ...declared.headers,
                      },
                    },
                  ),
                ),
            ),
          queryKeys: [],
        }),
      );
    },
  });

  const record = useIdempotentMutation({
    mutationKey,
    // A run's review actions reach the server in the order they were taken.
    scope: { id: mutationKey.join(":") },
    mutationFn: recordReview,
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
    },
    onError: (error, _variables, context) => rollback(error, context),
  });

  const acceptRoutine = resourceMutation({
    mutation: "acceptRoutineClaims",
    queryClient,
    mutationFn: async (
      { workspaceId: matterId, targetIds: claimIds }: BulkVariables,
      request: IdempotentRequest,
    ) => {
      const workspaceId = toSafeId<"workspace">(matterId);
      return answerOf(
        await runWorkspaceMutation({
          client: queryClient,
          request: async (mutationId) =>
            await invokeCapability(
              "lists.verifications.claim-reviews.bulk.create",
              async (declared) =>
                unwrapApiResponse(
                  await api.lists({ workspaceId })["claim-reviews"].bulk.post(
                    { runId, claimIds },
                    {
                      ...declared,
                      headers: {
                        "Idempotency-Key": request.headers["Idempotency-Key"],
                        "x-stella-mutation-id": mutationId,
                        ...declared.headers,
                      },
                    },
                  ),
                ),
            ),
          queryKeys: [],
        }),
      );
    },
  });

  const bulk = useIdempotentMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: acceptRoutine,
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
    },
  });

  return {
    recordEvent: (claimId: ClaimId, event: ClaimReviewEvent) => {
      record.mutate({
        workspaceId: scope.workspaceId,
        targetIds: [claimId],
        event,
      });
    },
    acceptRoutine: (claimIds: ClaimId[]) => {
      if (claimIds.length === 0) {
        return;
      }
      bulk.mutate({ workspaceId: scope.workspaceId, targetIds: claimIds });
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

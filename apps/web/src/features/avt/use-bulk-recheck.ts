/**
 * Re-check every out-of-date claim of a run on request. Nothing is graded
 * again on its own: the reviewer asks, and the claims go to the server in
 * requests of the size one grading round takes, each claim under its own
 * request key. A key is kept until its claim is re-checked and the run read
 * again shows it, so asking again after a failure, or after a run read that
 * failed, replays the grade rather than grading the claim twice. The run is
 * read again after every request, so claims leave the out-of-date set as
 * they are graded.
 */

import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { VERIFICATION_RECHECKS_PER_REQUEST_MAX } from "@stll/api-contract/verification-rechecks";
import { mapWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";

import { avtKeys } from "@/features/avt/queries";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";

/** A claim the re-check did not grade: why, when the server said, and
 *  whether asking again can help. */
export type BulkRecheckFailure = {
  claimId: string;
  message: string | null;
  retryable: boolean;
};

/** Where a bulk re-check stands. `finished` holds until it is dismissed or
 *  another starts, so the reviewer sees what it did. */
export type BulkRecheckState =
  | { type: "idle" }
  | { type: "running"; claimIds: ReadonlySet<string>; remaining: number }
  | {
      type: "finished";
      rechecked: number;
      failures: readonly BulkRecheckFailure[];
    };

/** One claim's place in the run's re-check of claims: none running for
 *  it, one running for it alone, or one running for it with others; and
 *  how to start one for it alone. */
export type ClaimRecheckRun = {
  state: "idle" | "alone" | "with-others";
  start: () => void;
};

type BulkRecheckScope = { workspaceId: string; runId: string };

type ChunkOutcome = { rechecked: string[]; failures: BulkRecheckFailure[] };

export const useBulkRecheck = ({ workspaceId, runId }: BulkRecheckScope) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<BulkRecheckState>({
    type: "idle",
  });
  // A claim's key outlives a failed attempt and is dropped once it lands.
  const keys = React.useRef(new Map<string, string>());
  const keyOf = (claimId: string) => {
    const known = keys.current.get(claimId);
    if (known !== undefined) {
      return known;
    }
    const key = createUuid();
    keys.current.set(claimId, key);
    return key;
  };
  const lists = api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) });

  const sendChunk = async (claimIds: readonly string[]) => {
    const body = {
      runId: toSafeId<"legalListVerificationRun">(runId),
      claims: claimIds.map((claimId) => ({
        claimId: toSafeId<"legalListClaim">(claimId),
        requestKey: keyOf(claimId),
      })),
    };
    return unwrapApiResponse(
      await invokeCapability(
        "lists.verifications.claim-rechecks.bulk.create",
        async (request) => lists["claim-rechecks"].bulk.post(body, request),
      ),
    ).results;
  };

  /** Read the run again; whether the read landed. */
  const refresh = async () =>
    Result.isOk(
      await Result.tryPromise(
        async () =>
          await queryClient.refetchQueries(
            { queryKey: avtKeys.run(workspaceId, runId) },
            { throwOnError: true },
          ),
      ),
    );

  /** A claim whose request did not get an answer: asking again may. */
  const askAgain = (claimId: string): BulkRecheckFailure => ({
    claimId,
    message: null,
    retryable: true,
  });

  const start = async (claimIds: readonly string[]) => {
    if (state.type === "running" || claimIds.length === 0) {
      return;
    }
    let remaining = claimIds.length;
    // The claims not yet answered: their own re-check waits for this one.
    const running = new Set(claimIds);
    setState({ type: "running", claimIds: new Set(running), remaining });
    // One request at a time: each is a full round of grading calls, and a
    // refusal of the whole request (a budget at its limit) stops the rest.
    let stopped = false;
    const outcomes = await mapWithConcurrency({
      items: chunkItems([...claimIds], VERIFICATION_RECHECKS_PER_REQUEST_MAX),
      limit: 1,
      operation: async (chunk): Promise<ChunkOutcome> => {
        if (stopped) {
          return { rechecked: [], failures: chunk.map(askAgain) };
        }
        const sent = await Result.tryPromise(
          async () => await sendChunk(chunk),
        );
        remaining -= chunk.length;
        for (const claimId of chunk) {
          running.delete(claimId);
        }
        setState({ type: "running", claimIds: new Set(running), remaining });
        const refreshed = await refresh();
        if (Result.isError(sent)) {
          stopped = true;
          notifyUserError(sent.error.cause, t("avt.staleness.failed"));
          return { rechecked: [], failures: chunk.map(askAgain) };
        }
        const rechecked: string[] = [];
        const failures: BulkRecheckFailure[] = [];
        for (const result of sent.value) {
          if (result.status === "rechecked") {
            rechecked.push(result.claimId);
          } else {
            failures.push({
              claimId: result.claimId,
              message: result.error.message,
              retryable: result.error.retryable,
            });
          }
        }
        // A key is freed only once the run read shows the new grade; until
        // then asking again replays it instead of grading the claim twice.
        if (refreshed) {
          for (const claimId of rechecked) {
            keys.current.delete(claimId);
          }
        }
        return { rechecked, failures };
      },
    });
    await queryClient.invalidateQueries({
      queryKey: avtKeys.reviewHistoryOfRun(workspaceId, runId),
    });
    setState({
      type: "finished",
      rechecked: outcomes.reduce(
        (sum, { rechecked }) => sum + rechecked.length,
        0,
      ),
      failures: outcomes.flatMap(({ failures }) => failures),
    });
  };

  const dismiss = () => {
    if (state.type === "finished") {
      setState({ type: "idle" });
    }
  };

  const runStateOf = (claimId: string): ClaimRecheckRun["state"] => {
    if (state.type !== "running" || !state.claimIds.has(claimId)) {
      return "idle";
    }
    return state.claimIds.size === 1 ? "alone" : "with-others";
  };
  const forClaim = (claimId: string): ClaimRecheckRun => ({
    state: runStateOf(claimId),
    start: () => detached(start([claimId]), "avt.claim-recheck"),
  });

  return { state, start, dismiss, forClaim };
};

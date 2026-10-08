import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
/**
 * Hook to manage decision analysis state.
 *
 * Draws a finished analysis from the analysis query's cache. Otherwise
 * enables the eligible observer and polls until complete. Explicit requests
 * retry failures.
 */

import { ANALYSIS_REQUEST_MODE } from "@stll/api-contract/case-law-analysis";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import {
  type AnalysisQueryResult,
  type DecisionAnalysisRequestKey,
  analysisRefetchInterval,
  decisionAnalysisOptions,
  requestDecisionAnalysis,
} from "@/features/case-law/queries/decision-analysis";
import { providerDiagnosticFromThrown } from "@/lib/errors/provider-diagnostic";
import { readQueryResult } from "@/lib/errors/query-result";

export type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error"; providerDiagnostic?: ProviderDiagnostic };

/**
 * This view's own explicit retry that failed in transport. It is the view's
 * state only while nothing newer reached the shared result: another view's
 * retry or a poll that answered since supersedes it.
 */
type RetryFailure = {
  error: unknown;
  /** When this view asked for the retry. */
  submittedAt: number;
  /** When the shared result last changed. */
  resultUpdatedAt: number;
};

/** Whether a failed retry is still this view's latest word on the analysis. */
const isCurrentRetryFailure = (
  retryFailure: RetryFailure | undefined,
): retryFailure is RetryFailure =>
  retryFailure !== undefined &&
  retryFailure.submittedAt >= retryFailure.resultUpdatedAt;

type AnalysisQuerySnapshot = {
  hasQueryError: boolean;
  isFetching: boolean;
  result: AnalysisQueryResult | undefined;
  queryError?: unknown;
  retryFailure?: RetryFailure | undefined;
};

/** Resolve retained query data into one unambiguous reader state. */
export const analysisStateFromQuery = ({
  hasQueryError,
  isFetching,
  result,
  queryError,
  retryFailure,
}: AnalysisQuerySnapshot): Exclude<AnalysisState, { status: "idle" }> => {
  // A finished analysis wins over everything, this view's failed retry too.
  if (result?.kind === "done") {
    return { status: "done", analysis: result.analysis };
  }

  const retryFailed = isCurrentRetryFailure(retryFailure);

  // TanStack Query retains the settled error result while a manual refetch is
  // in flight. Fetching must win, otherwise Retry appears to do nothing and
  // leaves the adjacent layer controls visually stuck beside a stale error.
  if (
    isFetching &&
    (result?.kind === "error" || hasQueryError || retryFailed)
  ) {
    return { status: "generating", tree: [] };
  }

  if (retryFailed) {
    const diagnostic = providerDiagnosticFromThrown(retryFailure.error);
    return {
      status: "error",
      ...(diagnostic === undefined ? {} : { providerDiagnostic: diagnostic }),
    };
  }

  // A failed poll retains its previous progress data, but polling has stopped.
  // Surface the settled failure so the reader can inspect it and retry.
  if (hasQueryError && !isFetching && result?.kind !== "error") {
    const diagnostic = providerDiagnosticFromThrown(queryError);
    return {
      status: "error",
      ...(diagnostic === undefined ? {} : { providerDiagnostic: diagnostic }),
    };
  }

  if (result !== undefined) {
    switch (result.kind) {
      case "generating":
        return { status: "generating", tree: result.tree };
      case "error":
        return {
          status: "error",
          ...(result.providerDiagnostic === undefined
            ? {}
            : { providerDiagnostic: result.providerDiagnostic }),
        };
      default:
        result satisfies never;
        return panic(`Unhandled analysis result: ${String(result)}`);
    }
  }

  return { status: "generating", tree: [] };
};

type UseDecisionAnalysisOptions = DecisionAnalysisRequestKey & {
  enabled: boolean;
};

export const useDecisionAnalysis = ({
  enabled,
  ...key
}: UseDecisionAnalysisOptions) => {
  const queryClient = useQueryClient();
  const options = decisionAnalysisOptions(key);
  const mutationKey = [...options.queryKey, "retry"];
  const retrying = useIsMutating({ mutationKey, exact: true }) > 0;
  const retry = useMutation({
    mutationKey,
    retry: false,
    mutationFn: async () => {
      await queryClient.cancelQueries({
        queryKey: options.queryKey,
        exact: true,
      });
      return readQueryResult(
        await requestDecisionAnalysis({
          decisionId: key.decisionId,
          mode: ANALYSIS_REQUEST_MODE.retry,
          signal: AbortSignal.timeout(15_000),
        }),
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(options.queryKey, result);
    },
  });
  // Disabled, the observer still reads the cache, so an analysis finished
  // earlier is drawn without asking for a run. An explicit retry owns the
  // transport until it settles; polling resumes only with the normal options.
  const query = useQuery({
    ...options,
    enabled: enabled && !retrying,
    refetchInterval: (current) =>
      retrying ? false : analysisRefetchInterval(current),
  });
  const retryFailure = retry.isError
    ? {
        error: retry.error,
        submittedAt: retry.submittedAt,
        resultUpdatedAt: query.dataUpdatedAt,
      }
    : undefined;
  const state: AnalysisState =
    !enabled && query.data?.kind !== "done"
      ? { status: "idle" }
      : analysisStateFromQuery({
          hasQueryError: query.isError,
          isFetching: query.isFetching || retrying,
          result: query.data,
          queryError: query.error,
          retryFailure,
        });

  // A retry is for a failed run, including one whose stale poll is still in
  // flight; a finished analysis is never retried.
  const failed =
    query.data?.kind === "error" ||
    query.isError ||
    isCurrentRetryFailure(retryFailure);
  const generate = () => {
    if (
      !enabled ||
      query.data?.kind === "done" ||
      !failed ||
      queryClient.isMutating({ mutationKey, exact: true }) > 0
    ) {
      return;
    }
    retry.mutate();
  };

  return { state, generate };
};

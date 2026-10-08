/**
 * Hook to manage decision analysis state.
 *
 * Draws a finished analysis from the analysis query's cache. Otherwise
 * enables the eligible observer and polls until the run settles: done, or an
 * error the server names. Explicit requests retry failures.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import {
  type AnalysisError,
  type AnalysisQueryResult,
  type DecisionAnalysisKey,
  decisionAnalysisOptions,
} from "@/features/case-law/queries/decision-analysis";
import { detached } from "@/lib/detached";

export type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error"; error: AnalysisError };

type AnalysisQuerySnapshot = {
  hasQueryError: boolean;
  isFetching: boolean;
  result: AnalysisQueryResult | undefined;
};

const UNREADABLE: AnalysisError = { kind: "unreadable" };

/** Resolve retained query data into one unambiguous reader state. */
export const analysisStateFromQuery = ({
  hasQueryError,
  isFetching,
  result,
}: AnalysisQuerySnapshot): Exclude<AnalysisState, { status: "idle" }> => {
  // TanStack Query retains the settled error result while a manual refetch is
  // in flight. Fetching must win, otherwise Retry appears to do nothing and
  // leaves the adjacent layer controls visually stuck beside a stale error.
  if (isFetching && (result?.kind === "error" || hasQueryError)) {
    return { status: "generating", tree: [] };
  }

  if (result !== undefined) {
    switch (result.kind) {
      case "done":
        return { status: "done", analysis: result.analysis };
      case "generating":
        return { status: "generating", tree: result.tree };
      case "error":
        return { status: "error", error: result.error };
      default:
        result satisfies never;
        return panic(`Unhandled analysis result: ${String(result)}`);
    }
  }

  return hasQueryError
    ? { status: "error", error: UNREADABLE }
    : { status: "generating", tree: [] };
};

/**
 * How Retry answers an error: a failed run asks the server for a new one (a
 * plain read keeps answering the failure), an unreadable answer reads again,
 * and a decision the server will never analyse offers no retry at all.
 */
export type AnalysisRetry = "new-run" | "read-again" | "none";

export const analysisRetryOf = (error: AnalysisError): AnalysisRetry => {
  switch (error.kind) {
    case "failed":
      return "new-run";
    case "unreadable":
      return "read-again";
    case "unavailable":
      return "none";
    default:
      error satisfies never;
      return panic("Unhandled analysis error");
  }
};

type UseDecisionAnalysisOptions = DecisionAnalysisKey & { enabled: boolean };

export const useDecisionAnalysis = ({
  enabled,
  ...key
}: UseDecisionAnalysisOptions) => {
  const queryClient = useQueryClient();
  const options = decisionAnalysisOptions(key);
  // Disabled, the observer still reads the cache, so an analysis finished
  // earlier is drawn without asking for a run.
  const query = useQuery({ ...options, enabled });
  // The same query fetched with `retry`: its answer (normally `generating`)
  // replaces the cached failure, and the observer resumes polling from it.
  const retry = useMutation({
    mutationFn: async () =>
      await queryClient.fetchQuery(
        decisionAnalysisOptions({ ...key, retry: true }),
      ),
  });
  const finishedAnalysis =
    query.data?.kind === "done" ? query.data.analysis : null;
  const refetch = query.refetch;

  const state: AnalysisState = (() => {
    if (finishedAnalysis !== null) {
      return { status: "done", analysis: finishedAnalysis };
    }
    if (!enabled) {
      return { status: "idle" };
    }
    // A retry that could not be sent leaves the failure it answered in the
    // cache, so the next Retry asks for a new run again.
    if (retry.isPending) {
      return { status: "generating", tree: [] };
    }
    return analysisStateFromQuery({
      hasQueryError: query.isError,
      isFetching: query.isFetching,
      result: query.data,
    });
  })();

  const generate = () => {
    if (!enabled || state.status !== "error") {
      return;
    }
    const action = analysisRetryOf(state.error);
    switch (action) {
      case "new-run":
        retry.mutate();
        return;
      case "read-again":
        detached(refetch(), "use-decision-analysis.refetch");
        return;
      case "none":
        return;
      default:
        action satisfies never;
        panic("Unhandled analysis retry");
    }
  };

  return { state, generate };
};

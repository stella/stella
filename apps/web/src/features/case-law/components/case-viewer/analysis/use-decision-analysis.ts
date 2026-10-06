/**
 * Hook to manage decision analysis state.
 *
 * Draws a finished analysis from the analysis query's cache. Otherwise
 * enables the eligible observer and polls until complete. Explicit requests
 * retry failures.
 */

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import {
  type AnalysisQueryResult,
  type DecisionAnalysisKey,
  decisionAnalysisOptions,
} from "@/features/case-law/queries/decision-analysis";
import { detached } from "@/lib/detached";

export type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error" };

type AnalysisQuerySnapshot = {
  hasQueryError: boolean;
  isFetching: boolean;
  result: AnalysisQueryResult | undefined;
};

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
        return { status: "error" };
      default:
        result satisfies never;
        return panic(`Unhandled analysis result: ${String(result)}`);
    }
  }

  return hasQueryError
    ? { status: "error" }
    : { status: "generating", tree: [] };
};

type UseDecisionAnalysisOptions = DecisionAnalysisKey & { enabled: boolean };

export const useDecisionAnalysis = ({
  enabled,
  ...key
}: UseDecisionAnalysisOptions) => {
  // Disabled, the observer still reads the cache, so an analysis finished
  // earlier is drawn without asking for a run.
  const query = useQuery({
    ...decisionAnalysisOptions(key),
    enabled,
  });
  const finishedAnalysis =
    query.data?.kind === "done" ? query.data.analysis : null;

  const hasErrorResult = query.data?.kind === "error" || query.isError;
  const refetch = query.refetch;

  const generate = () => {
    if (!enabled || finishedAnalysis !== null) {
      return;
    }
    // Allow retry when the previous attempt settled into an error
    // state: refetch the polling query so it picks up a fresh
    // result instead of staying on the cached failure.
    if (hasErrorResult) {
      detached(refetch(), "use-decision-analysis.refetch");
    }
  };

  const state: AnalysisState = (() => {
    if (finishedAnalysis !== null) {
      return { status: "done", analysis: finishedAnalysis };
    }
    if (!enabled) {
      return { status: "idle" };
    }
    return analysisStateFromQuery({
      hasQueryError: query.isError,
      isFetching: query.isFetching,
      result: query.data,
    });
  })();

  return { state, generate };
};

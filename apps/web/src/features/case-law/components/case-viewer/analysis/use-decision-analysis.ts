/**
 * Hook to manage decision analysis state.
 *
 * Draws a finished analysis from the analysis query's cache. Otherwise
 * enables the eligible observer and polls until the run settles: done, or an
 * error the server names. Explicit requests retry failures.
 */

import { useRef } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import { analysisRetryAt } from "@/features/case-law/components/case-viewer/analysis/analysis-error.logic";
import {
  type AnalysisError,
  type AnalysisQueryResult,
  type DecisionAnalysisKey,
  decisionAnalysisOptions,
} from "@/features/case-law/queries/decision-analysis";
import { readClientClockMs } from "@/hooks/client-clock";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useTimePassed } from "@/hooks/use-time-passed";
import { useAnalytics } from "@/lib/analytics/provider";
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
 * and a decision the server will never analyse offers no retry at all, nor
 * does a failed run before the retry time its provider named.
 */
export type AnalysisRetry = "new-run" | "read-again" | "none";

export const analysisRetryOf = (
  error: AnalysisError,
  /** Whether the clock has passed the failure's retry time (`useTimePassed`). */
  retryTimePassed: boolean,
): AnalysisRetry => {
  switch (error.kind) {
    case "failed":
      return retryTimePassed ? "new-run" : "none";
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
  const analytics = useAnalytics();
  const options = decisionAnalysisOptions(key);
  // Disabled, the observer still reads the cache, so an analysis finished
  // earlier is drawn without asking for a run.
  const query = useQuery({ ...options, enabled });
  // The same query fetched with `retry`: its answer (normally `generating`)
  // replaces the cached failure, and the observer resumes polling from it.
  const retry = useMutation({
    mutationFn: async () =>
      // `staleTime: 0`: a cached failure, however fresh, never answers the
      // reader's explicit request to run again.
      await queryClient.query({
        ...decisionAnalysisOptions({ ...key, retry: true }),
        staleTime: 0,
      }),
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

  const timingRef = useRef<{
    key: string;
    startedAt: number;
    firstSectionAt: number | null;
    firstResultSeen: boolean;
    sent: boolean;
    fromStore: boolean;
    leaveTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const timingKey = `${key.decisionId}:${key.decisionUpdatedAt}`;
  useExternalSyncEffect(() => {
    if (!enabled) {
      // The previous setup owns its deferred leave event; a later enable
      // starts a new visit even when the decision identity is unchanged.
      timingRef.current = null;
      return undefined;
    }
    const existing = timingRef.current;
    if (existing === null || existing.key !== timingKey) {
      timingRef.current = {
        key: timingKey,
        startedAt: readClientClockMs(),
        firstSectionAt: null,
        firstResultSeen: false,
        sent: false,
        fromStore: false,
        leaveTimer: null,
      };
    } else if (existing.leaveTimer !== null) {
      clearTimeout(existing.leaveTimer);
      existing.leaveTimer = null;
    }
    return () => {
      const timing = timingRef.current;
      if (timing === null || timing.key !== timingKey || timing.sent) {
        return;
      }
      timing.leaveTimer = setTimeout(() => {
        if (timing.sent) {
          return;
        }
        timing.sent = true;
        analytics.captureCaseLawAnalysisTiming({
          ms_to_first_section:
            timing.firstSectionAt === null
              ? null
              : Math.round(timing.firstSectionAt - timing.startedAt),
          ms_to_done: null,
          outcome: "left",
          from_store: timing.fromStore,
        });
      }, 0);
    };
  }, [analytics, enabled, timingKey]);

  useExternalSyncEffect(() => {
    const timing = timingRef.current;
    if (
      !enabled ||
      timing === null ||
      timing.key !== timingKey ||
      timing.sent
    ) {
      return;
    }
    const now = readClientClockMs();
    if (!timing.firstResultSeen && query.data !== undefined) {
      timing.firstResultSeen = true;
      timing.fromStore = query.data.kind === "done";
    }
    const hasSection =
      state.status === "done" ||
      (state.status === "generating" && state.tree.length > 0);
    if (hasSection && timing.firstSectionAt === null) {
      timing.firstSectionAt = now;
    }
    if (state.status !== "done" && state.status !== "error") {
      return;
    }
    timing.sent = true;
    analytics.captureCaseLawAnalysisTiming({
      ms_to_first_section:
        timing.firstSectionAt === null
          ? null
          : Math.round(timing.firstSectionAt - timing.startedAt),
      ms_to_done:
        state.status === "done" ? Math.round(now - timing.startedAt) : null,
      outcome: state.status,
      from_store: timing.fromStore,
    });
  }, [analytics, enabled, query.data, state, timingKey]);

  const retryTimePassed = useTimePassed(
    state.status === "error" ? analysisRetryAt(state.error) : undefined,
  );

  const generate = () => {
    if (!enabled || state.status !== "error") {
      return;
    }
    const action = analysisRetryOf(state.error, retryTimePassed);
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

/**
 * Hook to manage decision analysis state.
 *
 * Returns cached analysis immediately if persisted. Otherwise
 * triggers generation and polls until complete.
 */

import { useCallback, useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DecisionAnalysis } from "@stll/case-law/analysis";
import {
  isAnalysisInProgress,
  isDecisionAnalysis,
} from "@stll/case-law/analysis";

import { env } from "@/env";

type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error"; message: string };

type AnalysisResponse =
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "error"; error: string };

const POLL_INTERVAL_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseAnalysisResponse = (value: unknown): AnalysisResponse | null => {
  if (!isRecord(value)) {
    return null;
  }

  const status = value["status"];

  if (status === "done") {
    const analysis = value["analysis"];
    return isDecisionAnalysis(analysis) ? { status: "done", analysis } : null;
  }

  if (status === "generating") {
    const analysis = value["analysis"];
    return {
      status: "generating",
      tree: isDecisionAnalysis(analysis) ? analysis.tree : [],
    };
  }

  if (status === "error") {
    const error = value["error"];
    return {
      status: "error",
      error: typeof error === "string" ? error : "Generation failed",
    };
  }

  return null;
};

type AnalysisQueryResult =
  | { kind: "done"; analysis: DecisionAnalysis }
  | { kind: "generating"; tree: DecisionAnalysis["tree"] }
  | { kind: "error"; message: string };

const isTerminal = (result: AnalysisQueryResult): boolean =>
  result.kind === "done" || result.kind === "error";

export const useDecisionAnalysis = (
  decisionId: string,
  existingAnalysis: unknown,
) => {
  const queryClient = useQueryClient();
  const hasFreshAnalysis =
    isDecisionAnalysis(existingAnalysis) &&
    !isAnalysisInProgress(existingAnalysis);
  // Track which decision the user kicked generation off for. Comparing
  // against the current `decisionId` in the same render keeps a stale
  // value from enabling a fetch (and an unintended backend kick-off)
  // for an unrelated decision during a route transition.
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);
  const isGenerating = generatingFor === decisionId;

  // Clear the marker once the route moves on so returning to the
  // original decision lands in `idle` (matching prior behaviour)
  // instead of resuming a poll the user didn't request again.
  useEffect(() => {
    setGeneratingFor(null);
  }, [decisionId]);

  const enabled = isGenerating && !hasFreshAnalysis;

  const query = useQuery<AnalysisQueryResult>({
    queryKey: ["decision-analysis", decisionId],
    queryFn: async ({ signal }): Promise<AnalysisQueryResult> => {
      const response = await fetch(
        `${env.VITE_API_URL}/v1/case/decisions/${decisionId}/analysis`,
        {
          credentials: "include",
          signal,
        },
      );

      const data: unknown = await response.json();
      const parsed = parseAnalysisResponse(data);

      if (!parsed) {
        return {
          kind: "error",
          message: response.ok
            ? "Unexpected response"
            : `HTTP ${String(response.status)}`,
        };
      }

      if (parsed.status === "done") {
        return { kind: "done", analysis: parsed.analysis };
      }
      if (parsed.status === "generating") {
        return { kind: "generating", tree: parsed.tree };
      }
      return { kind: "error", message: parsed.error };
    },
    enabled,
    refetchInterval: (q) =>
      q.state.data && isTerminal(q.state.data) ? false : POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
    gcTime: 0,
  });

  // Mirror a `done` result into the decision query cache so route
  // re-renders pick up the persisted analysis without another fetch.
  useEffect(() => {
    if (query.data?.kind !== "done") {
      return;
    }
    const analysis = query.data.analysis;
    queryClient.setQueryData(
      ["case-law-decisions", decisionId],
      (old: Record<string, unknown> | undefined) =>
        old ? { ...old, analysis } : old,
    );
  }, [query.data, decisionId, queryClient]);

  const hasErrorResult = query.data?.kind === "error" || query.isError;
  const refetch = query.refetch;

  const generate = useCallback(() => {
    if (hasFreshAnalysis) {
      return;
    }
    // Allow retry when the previous attempt settled into an error
    // state: refetch the polling query so it picks up a fresh
    // result instead of staying on the cached failure.
    if (isGenerating && hasErrorResult) {
      void refetch();
      return;
    }
    if (isGenerating) {
      return;
    }
    setGeneratingFor(decisionId);
  }, [decisionId, hasErrorResult, hasFreshAnalysis, isGenerating, refetch]);

  const state: AnalysisState = (() => {
    if (hasFreshAnalysis && isDecisionAnalysis(existingAnalysis)) {
      return { status: "done", analysis: existingAnalysis };
    }
    if (!isGenerating) {
      return { status: "idle" };
    }
    if (query.data) {
      switch (query.data.kind) {
        case "done":
          return { status: "done", analysis: query.data.analysis };
        case "generating":
          return { status: "generating", tree: query.data.tree };
        case "error":
          return { status: "error", message: query.data.message };
      }
    }
    if (query.isError) {
      return {
        status: "error",
        message:
          query.error instanceof Error ? query.error.message : "Unknown error",
      };
    }
    return { status: "generating", tree: [] };
  })();

  return { state, generate };
};

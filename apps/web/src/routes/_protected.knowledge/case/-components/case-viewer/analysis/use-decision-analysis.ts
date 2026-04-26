/**
 * Hook to manage decision analysis state.
 *
 * Returns cached analysis immediately if persisted. Otherwise
 * triggers generation and polls until complete.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import type { DecisionAnalysis } from "@stella/case-law/analysis";
import {
  isAnalysisInProgress,
  isDecisionAnalysis,
} from "@stella/case-law/analysis";

import { env } from "@/env";

type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error"; message: string };

type AnalysisResponse =
  | { status: "done"; analysis?: unknown }
  | { status: "error"; error?: string }
  | { status: "generating"; analysis?: unknown };

const POLL_INTERVAL_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseAnalysisResponse = (value: unknown): AnalysisResponse | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (value["status"] === "done" || value["status"] === "generating") {
    return {
      status: value["status"],
      analysis: value["analysis"],
    };
  }

  if (value["status"] === "error") {
    return typeof value["error"] === "string"
      ? {
          status: value["status"],
          error: value["error"],
        }
      : {
          status: value["status"],
        };
  }

  return null;
};

export const useDecisionAnalysis = (
  decisionId: string,
  existingAnalysis: unknown,
) => {
  const [state, setState] = useState<AnalysisState>(() => {
    if (
      isDecisionAnalysis(existingAnalysis) &&
      !isAnalysisInProgress(existingAnalysis)
    ) {
      return { status: "done", analysis: existingAnalysis };
    }
    return { status: "idle" };
  });

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  // Reset to idle when decisionId changes (route navigation)
  const prevDecisionId = useRef(decisionId);
  useEffect(() => {
    if (prevDecisionId.current !== decisionId) {
      prevDecisionId.current = decisionId;
      abortRef.current?.abort();
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }

      if (
        isDecisionAnalysis(existingAnalysis) &&
        !isAnalysisInProgress(existingAnalysis)
      ) {
        setState({ status: "done", analysis: existingAnalysis });
      } else {
        setState({ status: "idle" });
      }
      return;
    }

    if (
      isDecisionAnalysis(existingAnalysis) &&
      !isAnalysisInProgress(existingAnalysis) &&
      state.status !== "done"
    ) {
      setState({ status: "done", analysis: existingAnalysis });
    }
  }, [existingAnalysis, state.status, decisionId]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    },
    [],
  );

  /** Returns true if analysis resolved (done or error), false if still generating. */
  const fetchAnalysis = useCallback(async (): Promise<boolean> => {
    const controller = new AbortController();
    abortRef.current = controller;

    const response = await fetch(
      `${env.VITE_API_URL}/v1/case/decisions/${decisionId}/analysis`,
      {
        credentials: "include",
        signal: controller.signal,
      },
    );

    const data: unknown = await response.json();

    const analysisResponse = parseAnalysisResponse(data);
    if (analysisResponse) {
      if (
        analysisResponse.status === "done" &&
        isDecisionAnalysis(analysisResponse.analysis)
      ) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setState({ status: "done", analysis: analysisResponse.analysis });
        queryClient.setQueryData(
          ["case-law-decisions", decisionId],
          (old: Record<string, unknown> | undefined) =>
            old ? { ...old, analysis: analysisResponse.analysis } : old,
        );
        return true;
      }

      if (analysisResponse.status === "generating") {
        setState({
          status: "generating",
          tree: isDecisionAnalysis(analysisResponse.analysis)
            ? analysisResponse.analysis.tree
            : [],
        });
        return false;
      }

      if (analysisResponse.status === "error") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setState({
          status: "error",
          message: analysisResponse.error ?? "Generation failed",
        });
        return true;
      }
    }

    // Unexpected response shape (auth failure, server error, etc.)
    // Treat as error to stop polling
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setState({
      status: "error",
      message: response.ok ? "Unexpected response" : `HTTP ${response.status}`,
    });
    return true;
  }, [decisionId, queryClient]);

  const generate = useCallback(async () => {
    if (state.status === "generating") {
      return;
    }

    setState({ status: "generating", tree: [] });

    try {
      const resolved = await fetchAnalysis();

      // Only poll if the first fetch didn't already resolve
      if (!resolved) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
        }
        pollRef.current = setInterval(() => {
          void fetchAnalysis().catch(() => {
            // Ignore poll errors; will retry on next interval
          });
        }, POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (abortRef.current?.signal.aborted) {
        return;
      }
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }, [state.status, fetchAnalysis]);

  return { state, generate };
};

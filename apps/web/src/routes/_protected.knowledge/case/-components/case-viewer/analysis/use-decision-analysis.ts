/**
 * Hook to manage decision analysis state.
 *
 * Returns cached analysis immediately if persisted. Otherwise
 * triggers generation and polls until complete.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { env } from "@/env";

import type { DecisionAnalysis } from "./types";

type AnalysisState =
  | { status: "idle" }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "error"; message: string };

const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  typeof val === "object" &&
  val !== null &&
  "version" in val &&
  "tree" in val;

const POLL_INTERVAL_MS = 2000;

export const useDecisionAnalysis = (
  decisionId: string,
  existingAnalysis: unknown,
) => {
  const [state, setState] = useState<AnalysisState>(() => {
    if (
      isDecisionAnalysis(existingAnalysis) &&
      !("status" in (existingAnalysis as object))
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
      if (pollRef.current) clearInterval(pollRef.current);

      if (
        isDecisionAnalysis(existingAnalysis) &&
        !("status" in (existingAnalysis as object))
      ) {
        setState({ status: "done", analysis: existingAnalysis });
      } else {
        setState({ status: "idle" });
      }
      return;
    }

    if (
      isDecisionAnalysis(existingAnalysis) &&
      !("status" in (existingAnalysis as object)) &&
      state.status !== "done"
    ) {
      setState({ status: "done", analysis: existingAnalysis });
    }
  }, [existingAnalysis, state.status, decisionId]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (pollRef.current) clearInterval(pollRef.current);
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

    if (
      typeof data === "object" &&
      data !== null &&
      "status" in data
    ) {
      const obj = data as { status: string; analysis?: unknown; error?: string };

      if (obj.status === "done" && isDecisionAnalysis(obj.analysis)) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setState({ status: "done", analysis: obj.analysis });
        queryClient.setQueryData(
          ["case-law-decisions", decisionId],
          (old: Record<string, unknown> | undefined) =>
            old ? { ...old, analysis: obj.analysis } : old,
        );
        return true;
      }

      if (obj.status === "generating") {
        const partial = obj.analysis as DecisionAnalysis | undefined;
        setState({
          status: "generating",
          tree: partial?.tree ?? [],
        });
        return false;
      }

      if (obj.status === "error") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setState({
          status: "error",
          message: obj.error ?? "Generation failed",
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
    if (state.status === "generating") return;

    setState({ status: "generating", tree: [] });

    try {
      const resolved = await fetchAnalysis();

      // Only poll if the first fetch didn't already resolve
      if (!resolved) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            await fetchAnalysis();
          } catch {
            // Ignore poll errors; will retry on next interval
          }
        }, POLL_INTERVAL_MS);
      }
    } catch (err) {
      if (abortRef.current?.signal.aborted) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [state.status, fetchAnalysis]);

  return { state, generate };
};

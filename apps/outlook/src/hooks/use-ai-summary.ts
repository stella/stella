import { useState } from "react";

import { Result } from "better-result";

import { parseOutlookAISummaryResponse } from "@stll/api-contract";

import { buildAISummaryRequest } from "@/hooks/ai-request.logic";
import { requestOutlookApi } from "@/lib/api";
import { APIError, userErrorMessage } from "@/lib/api-error";

const AI_REQUEST_TIMEOUT_MS = 70_000;

export type AISummaryState =
  | { type: "idle" }
  | { type: "loading" }
  | { summary: string; type: "ready" }
  | { message: string; type: "error" };

type UseAISummary = {
  state: AISummaryState;
  summarize: (args: { language?: string; text: string }) => void;
};

export const useAISummary = (errorFallback: string): UseAISummary => {
  const [state, setState] = useState<AISummaryState>({ type: "idle" });

  const summarize = async ({
    language,
    text,
  }: {
    language?: string;
    text: string;
  }) => {
    setState({ type: "loading" });
    const result = await Result.tryPromise(async () =>
      requestOutlookApi({
        body: buildAISummaryRequest({ language, text }),
        method: "POST",
        parse: parseOutlookAISummaryResponse,
        path: "/ai/summarize",
        timeoutMs: AI_REQUEST_TIMEOUT_MS,
      }),
    );
    if (Result.isError(result)) {
      setState({
        message:
          result.error instanceof APIError
            ? userErrorMessage(result.error, errorFallback)
            : errorFallback,
        type: "error",
      });
      return;
    }
    setState({ summary: result.value.summary, type: "ready" });
  };

  return {
    state,
    summarize: (args) => {
      summarize(args).catch(() =>
        setState({ message: errorFallback, type: "error" }),
      );
    },
  };
};

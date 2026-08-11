import { useState } from "react";

import { Result } from "better-result";

import { api, withTimeout } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/api-error";

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
    const result = await Result.tryPromise(
      async () =>
        await api.ai.summarize.post(
          {
            text,
            ...(language ? { language } : {}),
          },
          withTimeout(AI_REQUEST_TIMEOUT_MS),
        ),
    );
    if (Result.isError(result)) {
      setState({ message: errorFallback, type: "error" });
      return;
    }
    const { data, error } = result.value;
    if (error) {
      const apiError = toAPIError(error);
      setState({
        message: userErrorMessage(apiError, errorFallback),
        type: "error",
      });
      return;
    }
    setState({ summary: data.summary, type: "ready" });
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

import { useState } from "react";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/api-error";

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
    const { data, error } = await api.ai.summarize.post({
      text,
      ...(language ? { language } : {}),
    });
    if (error) {
      setState({
        message: toAPIError(error).message || errorFallback,
        type: "error",
      });
      return;
    }
    setState({ summary: data.summary, type: "ready" });
  };

  return { state, summarize: (args) => void summarize(args) };
};

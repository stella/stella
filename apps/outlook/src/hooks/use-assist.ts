import { useState } from "react";

import { Result } from "better-result";

import {
  parseOutlookAIDraftResponse,
  parseOutlookAISummaryResponse,
} from "@stll/api-contract/outlook-ai";

import {
  buildAIAskRequest,
  buildAIDraftRequest,
  buildAISummaryRequest,
} from "@/hooks/ai-request.logic";
import {
  type AssistRequest,
  type AssistTurn,
  createAssistTurns,
} from "@/hooks/assist-turns.logic";
import { type AskEmailSource, parseAskEmailResponse } from "@/lib/api-schemas";
import { requestOutlookApi } from "@/lib/outlook-api-client";
import {
  OutlookAPIError,
  outlookUserErrorMessage,
} from "@/lib/outlook-api-error";

const AI_REQUEST_TIMEOUT_MS = 70_000;
/** Older turns drop off; the pane is a working surface, not a history. */
const MAX_TURNS = 6;

const request = async ({
  instruction,
  kind,
  snapshot,
  workspaceId,
}: AssistRequest): Promise<{ sources: AskEmailSource[]; text: string }> => {
  if (kind === "summary") {
    const response = await requestOutlookApi({
      body: buildAISummaryRequest({ text: snapshot.bodyText }),
      method: "POST",
      parse: parseOutlookAISummaryResponse,
      path: "/ai/summarize",
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
    });
    return { sources: [], text: response.summary };
  }
  if (kind === "draft") {
    const response = await requestOutlookApi({
      body: buildAIDraftRequest({ intent: instruction, snapshot }),
      method: "POST",
      parse: parseOutlookAIDraftResponse,
      path: "/ai/draft-email",
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
    });
    return { sources: [], text: response.draft };
  }
  const response = await requestOutlookApi({
    body: buildAIAskRequest({ question: instruction, snapshot, workspaceId }),
    method: "POST",
    parse: parseAskEmailResponse,
    path: "/ai/ask-email",
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
  });
  return { sources: response.sources, text: response.answer };
};

/**
 * The assistant's turns for one email, newest first: summaries, answers and
 * reply drafts, each loading, ready or failed on its own.
 */
export const useAssist = (errorFallback: string) => {
  const [turns, setTurns] = useState<AssistTurn[]>([]);
  const [assist] = useState(() =>
    createAssistTurns({
      errorFallback,
      maxTurns: MAX_TURNS,
      newId: () => crypto.randomUUID(),
      onChange: setTurns,
      send: async (args) => {
        const result = await Result.tryPromise({
          catch: (cause) => cause,
          try: async () => await request(args),
        });
        if (Result.isError(result)) {
          return {
            message:
              result.error instanceof OutlookAPIError
                ? outlookUserErrorMessage(result.error, errorFallback)
                : errorFallback,
            type: "error",
          };
        }
        return {
          sources: result.value.sources,
          text: result.value.text,
          type: "ready",
        };
      },
    }),
  );

  return {
    ask: assist.ask,
    isBusy: turns.some((turn) => turn.state.type === "loading"),
    retry: assist.retry,
    turns,
  };
};

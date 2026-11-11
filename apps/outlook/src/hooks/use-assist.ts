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
import { type AskEmailSource, parseAskEmailResponse } from "@/lib/api-schemas";
import { requestOutlookApi } from "@/lib/outlook-api-client";
import {
  OutlookAPIError,
  outlookUserErrorMessage,
} from "@/lib/outlook-api-error";
import type { MailSnapshot } from "@/types";

const AI_REQUEST_TIMEOUT_MS = 70_000;
/** Older turns drop off; the pane is a working surface, not a history. */
const MAX_TURNS = 6;

export type AssistKind = "answer" | "draft" | "summary";

export type AssistTurnState =
  | { type: "loading" }
  | { sources: AskEmailSource[]; text: string; type: "ready" }
  | { message: string; type: "error" };

export type AssistTurn = {
  readonly id: string;
  readonly kind: AssistKind;
  /** What the user asked for, shown as the turn's heading. */
  readonly prompt: string;
  readonly state: AssistTurnState;
};

type AskArgs = {
  /** The text sent to the model: the question, or the reply instruction. */
  instruction: string;
  kind: AssistKind;
  prompt: string;
  snapshot: MailSnapshot;
  workspaceId: string | null;
};

const request = async ({
  instruction,
  kind,
  snapshot,
  workspaceId,
}: AskArgs): Promise<{ sources: AskEmailSource[]; text: string }> => {
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

  const update = (id: string, state: AssistTurnState) =>
    setTurns((current) =>
      current.map((turn) => (turn.id === id ? { ...turn, state } : turn)),
    );

  const ask = (args: AskArgs) => {
    const id = crypto.randomUUID();
    const turn: AssistTurn = {
      id,
      kind: args.kind,
      prompt: args.prompt,
      state: { type: "loading" },
    };
    setTurns((current) => [turn, ...current].slice(0, MAX_TURNS));
    run(id, args).catch(() =>
      update(id, { message: errorFallback, type: "error" }),
    );
  };

  const run = async (id: string, args: AskArgs) => {
    const result = await Result.tryPromise({
      catch: (cause) => cause,
      try: async () => await request(args),
    });
    if (Result.isError(result)) {
      update(id, {
        message:
          result.error instanceof OutlookAPIError
            ? outlookUserErrorMessage(result.error, errorFallback)
            : errorFallback,
        type: "error",
      });
      return;
    }
    update(id, { ...result.value, type: "ready" });
  };

  return {
    ask,
    isBusy: turns.some((turn) => turn.state.type === "loading"),
    turns,
  };
};

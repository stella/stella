import { useState } from "react";

import { Result } from "better-result";

import { parseOutlookAIDraftResponse } from "@stll/api-contract";

import { buildAIDraftRequest } from "@/hooks/ai-request.logic";
import { requestOutlookApi } from "@/lib/api";
import { APIError, userErrorMessage } from "@/lib/api-error";
import type { MailSnapshot } from "@/types";

const AI_REQUEST_TIMEOUT_MS = 70_000;

export type AIDraftState =
  | { type: "idle" }
  | { type: "loading" }
  | { draft: string; type: "ready" }
  | { message: string; type: "error" };

type DraftArgs = {
  intent: string;
  language?: string;
  snapshot: MailSnapshot;
};

type UseAIDraft = {
  draftReply: (args: DraftArgs) => void;
  state: AIDraftState;
};

export const useAIDraft = (errorFallback: string): UseAIDraft => {
  const [state, setState] = useState<AIDraftState>({ type: "idle" });

  const draftReply = async ({ intent, language, snapshot }: DraftArgs) => {
    setState({ type: "loading" });
    const result = await Result.tryPromise(async () =>
      requestOutlookApi({
        body: buildAIDraftRequest({ intent, language, snapshot }),
        method: "POST",
        parse: parseOutlookAIDraftResponse,
        path: "/ai/draft-email",
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
    setState({ draft: result.value.draft, type: "ready" });
  };

  return {
    draftReply: (args) => {
      draftReply(args).catch(() =>
        setState({ message: errorFallback, type: "error" }),
      );
    },
    state,
  };
};

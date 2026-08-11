import { useState } from "react";

import { Result } from "better-result";

import { api, withTimeout } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/api-error";
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
    const originalFrom = snapshot.from?.email;
    const result = await Result.tryPromise(
      async () =>
        await api.ai["draft-email"].post(
          {
            intent,
            originalBody: snapshot.bodyText,
            originalSubject: snapshot.subject,
            ...(originalFrom ? { originalFrom } : {}),
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
    setState({ draft: data.draft, type: "ready" });
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

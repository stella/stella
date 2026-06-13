import { useState } from "react";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { MailSnapshot } from "@/types";

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
    const { data, error } = await api.ai["draft-email"].post({
      intent,
      originalBody: snapshot.bodyText,
      originalSubject: snapshot.subject,
      ...(originalFrom ? { originalFrom } : {}),
      ...(language ? { language } : {}),
    });
    if (error) {
      setState({
        message: toAPIError(error).message || errorFallback,
        type: "error",
      });
      return;
    }
    setState({ draft: data.draft, type: "ready" });
  };

  return { draftReply: (args) => void draftReply(args), state };
};

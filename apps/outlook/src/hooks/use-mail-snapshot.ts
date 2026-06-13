import { useCallback, useEffect, useState } from "react";

import { Result } from "better-result";

import { loadMailSnapshot } from "@/outlook";
import type { MailSnapshot } from "@/types";

export type MailSnapshotState =
  | { type: "loading" }
  | { snapshot: MailSnapshot; type: "ready" }
  | { message: string; type: "error" };

type UseMailSnapshot = {
  refresh: () => void;
  state: MailSnapshotState;
};

export const useMailSnapshot = (errorFallback: string): UseMailSnapshot => {
  const [state, setState] = useState<MailSnapshotState>({ type: "loading" });

  const refresh = useCallback(async () => {
    setState({ type: "loading" });
    const result = await Result.tryPromise(
      async () => await loadMailSnapshot(),
    );
    if (Result.isError(result)) {
      const { error } = result;
      setState({
        message: error instanceof Error ? error.message : errorFallback,
        type: "error",
      });
      return;
    }
    setState({ snapshot: result.value, type: "ready" });
  }, [errorFallback]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { refresh: () => void refresh(), state };
};

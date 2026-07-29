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

  const load = useCallback(async (): Promise<MailSnapshotState> => {
    const result = await Result.tryPromise(
      async () => await loadMailSnapshot(),
    );
    if (Result.isError(result)) {
      const { error } = result;
      return {
        message: error instanceof Error ? error.message : errorFallback,
        type: "error",
      };
    }
    return { snapshot: result.value, type: "ready" };
  }, [errorFallback]);

  useEffect(() => {
    let active = true;
    void load().then((nextState) => {
      if (active) {
        setState(nextState);
      }
      return nextState;
    });
    return () => {
      active = false;
    };
  }, [load]);

  return {
    refresh: () => {
      setState({ type: "loading" });
      void load().then(setState);
    },
    state,
  };
};

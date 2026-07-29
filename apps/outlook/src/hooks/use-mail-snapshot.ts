import { useCallback, useEffect, useRef, useState } from "react";

import { Result } from "better-result";

import { loadMailSnapshot, subscribeMailboxItemChanges } from "@/outlook";
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
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const result = await Result.tryPromise(
      async () => await loadMailSnapshot(),
    );
    if (sequence !== loadSequence.current) {
      return;
    }
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
    let active = true;
    queueMicrotask(() => {
      if (active) {
        void load();
      }
    });
    const unsubscribe = subscribeMailboxItemChanges(() => {
      setState({ type: "loading" });
      void load();
    });
    return () => {
      active = false;
      loadSequence.current += 1;
      unsubscribe();
    };
  }, [load]);

  return {
    refresh: () => {
      setState({ type: "loading" });
      void load();
    },
    state,
  };
};

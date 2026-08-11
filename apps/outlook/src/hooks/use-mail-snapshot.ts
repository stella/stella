import { useCallback, useEffect, useRef, useState } from "react";

import { Result } from "better-result";

import { loadMailSnapshot, subscribeMailboxItemChanges } from "@/outlook";
import type { MailSnapshot } from "@/types";

export type MailSnapshotState =
  | { type: "loading" }
  | { snapshot: MailSnapshot; type: "ready" }
  | { message: string; type: "error" };

type UseMailSnapshot = {
  loadLatest: () => Promise<MailSnapshot>;
  refresh: () => void;
  state: MailSnapshotState;
};

export const useMailSnapshot = (errorFallback: string): UseMailSnapshot => {
  const [state, setState] = useState<MailSnapshotState>({ type: "loading" });
  const itemInstanceSequence = useRef(0);
  const loadSequence = useRef(0);

  const load = useCallback(
    async (itemInstanceKey: string) => {
      const sequence = ++loadSequence.current;
      const result = await Result.tryPromise(
        async () => await loadMailSnapshot(itemInstanceKey),
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
    },
    [errorFallback],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        void load(`item-${String(itemInstanceSequence.current)}`);
      }
    });
    const unsubscribe = subscribeMailboxItemChanges(() => {
      itemInstanceSequence.current += 1;
      setState({ type: "loading" });
      void load(`item-${String(itemInstanceSequence.current)}`);
    });
    return () => {
      active = false;
      loadSequence.current += 1;
      unsubscribe();
    };
  }, [load]);

  return {
    loadLatest: async () => {
      const itemInstanceKey = `item-${String(itemInstanceSequence.current)}`;
      const snapshot = await loadMailSnapshot(itemInstanceKey);
      setState({ snapshot, type: "ready" });
      return snapshot;
    },
    refresh: () => {
      setState({ type: "loading" });
      void load(`item-${String(itemInstanceSequence.current)}`);
    },
    state,
  };
};

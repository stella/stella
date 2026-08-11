import { useCallback, useEffect, useRef, useState } from "react";

import { Result } from "better-result";

import { isAttachmentReadError, OutlookError } from "@/lib/outlook-error";
import { loadMailSnapshot, subscribeMailboxItemChanges } from "@/outlook";
import type { MailSnapshot } from "@/types";

export type MailSnapshotState =
  | { type: "loading" }
  | { snapshot: MailSnapshot; type: "ready" }
  | { message: string; type: "error" };

type UseMailSnapshot = {
  isCurrent: (itemInstanceKey: string) => boolean;
  loadLatest: () => Promise<MailSnapshot>;
  refresh: () => void;
  state: MailSnapshotState;
};

type UseMailSnapshotOptions = {
  attachmentErrorFallback: string;
  errorFallback: string;
};

const snapshotErrorMessage = ({
  attachmentErrorFallback,
  error,
  errorFallback,
}: {
  attachmentErrorFallback: string;
  error: unknown;
  errorFallback: string;
}): string => {
  if (isAttachmentReadError(error)) {
    return attachmentErrorFallback;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return errorFallback;
};

export const useMailSnapshot = ({
  attachmentErrorFallback,
  errorFallback,
}: UseMailSnapshotOptions): UseMailSnapshot => {
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
          message: snapshotErrorMessage({
            attachmentErrorFallback,
            error,
            errorFallback,
          }),
          type: "error",
        });
        return;
      }
      setState({ snapshot: result.value, type: "ready" });
    },
    [attachmentErrorFallback, errorFallback],
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
    isCurrent: (itemInstanceKey) =>
      itemInstanceKey === `item-${String(itemInstanceSequence.current)}`,
    loadLatest: async () => {
      const itemInstanceKey = `item-${String(itemInstanceSequence.current)}`;
      const sequence = ++loadSequence.current;
      const snapshot = await loadMailSnapshot(itemInstanceKey);
      if (
        sequence !== loadSequence.current ||
        itemInstanceKey !== `item-${String(itemInstanceSequence.current)}`
      ) {
        throw new OutlookError({ message: errorFallback });
      }
      setState({ snapshot, type: "ready" });
      return snapshot;
    },
    refresh: () => {
      itemInstanceSequence.current += 1;
      setState({ type: "loading" });
      void load(`item-${String(itemInstanceSequence.current)}`);
    },
    state,
  };
};

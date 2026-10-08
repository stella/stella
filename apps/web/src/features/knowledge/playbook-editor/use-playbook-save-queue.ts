import { useRef, useState } from "react";

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { Result } from "better-result";

import type { ApiErrorInput } from "@stll/api-contract";
import { parseApiErrorValue } from "@stll/api-contract";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";

import type { PlaybookDraft } from "./playbook-editor.logic";

type DetailSaveSubscriptionOptions = {
  queryClient: QueryClient;
  queryKey: QueryKey | null;
  onSaved: () => void;
};

export const usePlaybookDetailSaveSubscription = ({
  queryClient,
  queryKey,
  onSaved,
}: DetailSaveSubscriptionOptions) => {
  const handleSaved = useLatestCallback(onSaved);
  useMountEffect(() => {
    if (queryKey === null) {
      return undefined;
    }
    const cache = queryClient.getQueryCache();
    const detailQuery = cache.find({ queryKey, exact: true });
    return cache.subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query === detailQuery
      ) {
        handleSaved();
      }
    });
  });
};

export type SaveOutcome =
  | { type: "saved"; updatedAt: string | null }
  | { type: "conflict"; error: ApiErrorInput }
  | { type: "failed"; error: ApiErrorInput };

export type SendSaveArgs = {
  savedDraft: PlaybookDraft;
  expectedUpdatedAt: string | null;
};

type SaveQueueOptions = {
  updatedAt: string | null;
  sendSave: (args: SendSaveArgs) => Promise<SaveOutcome>;
};

type FlushOnLeaveOptions = {
  draft: PlaybookDraft;
  isDirty: boolean;
  canSaveDraft: boolean;
};

export const usePlaybookSaveQueue = ({
  updatedAt,
  sendSave,
}: SaveQueueOptions) => {
  const inFlightSaveRef = useRef<Promise<SaveOutcome> | null>(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);

  const queueSave = async (savedDraft: PlaybookDraft) => {
    setPendingSaveCount((count) => count + 1);
    const previous = inFlightSaveRef.current;
    const tokenAtCall = updatedAt;
    const request = (async (): Promise<SaveOutcome> => {
      const before = previous === null ? null : await previous;
      const expectedUpdatedAt =
        before?.type === "saved" && before.updatedAt !== null
          ? before.updatedAt
          : tokenAtCall;
      const result = await Result.tryPromise({
        try: async () => await sendSave({ savedDraft, expectedUpdatedAt }),
        catch: (error) => error,
      });
      return Result.isError(result)
        ? {
            type: "failed",
            error: { status: 0, value: parseApiErrorValue(result.error) },
          }
        : result.value;
    })();
    inFlightSaveRef.current = request;
    try {
      const outcome = await request;
      return { outcome, isLatest: inFlightSaveRef.current === request };
    } finally {
      setPendingSaveCount((count) => count - 1);
      if (inFlightSaveRef.current === request) {
        inFlightSaveRef.current = null;
      }
    }
  };

  const flushOnLeave = async ({
    draft,
    isDirty,
    canSaveDraft,
  }: FlushOnLeaveOptions) => {
    // A reverted form is clean against the old baseline while an older edit
    // can still be saving. Queue its final content behind that request too.
    if (!canSaveDraft || (!isDirty && inFlightSaveRef.current === null)) {
      return null;
    }
    return await queueSave(draft);
  };

  return {
    queueSave,
    flushOnLeave,
    pendingSaveCount,
    hasPendingSave: () => inFlightSaveRef.current !== null,
  };
};

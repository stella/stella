import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import { restoreChatWebSearchQuerySnapshots } from "./chat-web-search-toggle.logic";

describe("web-search optimistic rollback", () => {
  test("restores heterogeneous entries exactly without recreating removed queries", () => {
    const queryClient = new QueryClient();
    const threadRef = {
      scope: "global",
      threadId: toChatThreadId("thread-A"),
    } as const;
    const threadKey = chatKeys.thread("org-A", threadRef);
    const draftMetaKey = chatKeys.draftMeta("org-A", threadRef);
    const removedKey = chatKeys.thread("org-A", {
      ...threadRef,
      allowMissingThread: true,
    });
    const laterVariantKey = chatKeys.thread("org-A", {
      ...threadRef,
      contextKind: "active-file",
    });
    const previousThread = {
      messages: ["before"],
      webSearchEnabled: false,
    };
    const previousDraftMeta = {
      model: "provider::before",
      webSearchEnabled: false,
    };
    const previousRemoved = {
      source: "removed",
      webSearchEnabled: false,
    };

    queryClient.setQueryData(threadKey, previousThread);
    queryClient.setQueryData(draftMetaKey, previousDraftMeta);
    queryClient.setQueryData(removedKey, previousRemoved);
    const snapshots = queryClient.getQueriesData({
      predicate: (query) => query.queryKey.at(4) === threadRef.threadId,
    });

    queryClient.setQueriesData(
      { predicate: (query) => query.queryKey.at(4) === threadRef.threadId },
      (old) =>
        old !== null && typeof old === "object"
          ? { ...old, webSearchEnabled: true }
          : old,
    );
    queryClient.setQueryData(laterVariantKey, {
      source: "created-after-snapshot",
      webSearchEnabled: true,
    });
    queryClient.removeQueries({ exact: true, queryKey: removedKey });

    restoreChatWebSearchQuerySnapshots(queryClient, snapshots);

    const restoredThread = queryClient.getQueryData(threadKey);
    const restoredDraftMeta = queryClient.getQueryData(draftMetaKey);
    const laterVariant = queryClient.getQueryData(laterVariantKey);
    const removed = queryClient.getQueryData(removedKey);
    expect(restoredThread).toEqual(previousThread);
    expect(restoredDraftMeta).toEqual(previousDraftMeta);
    expect(laterVariant).toEqual({
      source: "created-after-snapshot",
      webSearchEnabled: true,
    });
    expect(removed).toBeUndefined();
  });
});

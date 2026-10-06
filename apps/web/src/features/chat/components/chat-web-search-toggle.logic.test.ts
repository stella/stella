import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { chatThreadOptions, matchesChatThread } from "@/features/chat/queries";
import type { ChatThreadFetched } from "@/features/chat/queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import { restoreChatWebSearchQuerySnapshots } from "./chat-web-search-toggle.logic";

describe("web-search optimistic rollback", () => {
  test("restores canonical thread variants exactly without recreating removed queries", () => {
    const queryClient = new QueryClient();
    const threadRef = {
      scope: "global",
      threadId: toChatThreadId("thread-A"),
    } as const;
    const threadKey = chatThreadOptions({
      activeOrganizationId: "org-A",
      key: threadRef,
      context: {},
    }).queryKey;
    const draftThreadKey = chatThreadOptions({
      activeOrganizationId: "org-A",
      key: threadRef,
      context: { allowMissingThread: true },
    }).queryKey;
    const removedKey = chatThreadOptions({
      activeOrganizationId: "org-A",
      key: threadRef,
      context: {
        getActiveFile: () => ({ entityId: "file-A", fileName: "File" }),
      },
    }).queryKey;
    const laterVariantKey = chatThreadOptions({
      activeOrganizationId: "org-A",
      key: threadRef,
      context: {
        getActiveTemplate: () => ({
          templateId: "template-A",
          fileName: "Template",
        }),
      },
    }).queryKey;
    const previousThread = {
      activeTurnId: null,
      attachedFiles: { fileCount: 0, files: [] },
      forkProvenance: { type: "none" },
      messages: [],
      olderCursor: null,
      contextMatterIds: [],
      lastActivityAt: null,
      threadRevision: null,
      threadExists: true,
      usedAnonymization: false,
      webSearchAvailable: true,
      webSearchEnabled: false,
      context: null,
      model: null,
      reasoningEffort: null,
    } satisfies ChatThreadFetched;
    const previousDraftThread = { ...previousThread, threadExists: false };
    const previousRemoved = {
      ...previousThread,
      contextMatterIds: ["matter-A"],
    };
    const laterThread = { ...previousThread, webSearchEnabled: true };

    queryClient.setQueryData(threadKey, previousThread);
    queryClient.setQueryData(draftThreadKey, previousDraftThread);
    queryClient.setQueryData(removedKey, previousRemoved);
    const snapshots = queryClient.getQueriesData({
      predicate: (query) => matchesChatThread(query.queryKey, threadRef),
    });

    queryClient.setQueriesData(
      { predicate: (query) => matchesChatThread(query.queryKey, threadRef) },
      (old) =>
        old !== null && typeof old === "object"
          ? { ...old, webSearchEnabled: true }
          : old,
    );
    queryClient.setQueryData(laterVariantKey, laterThread);
    queryClient.removeQueries({ exact: true, queryKey: removedKey });

    restoreChatWebSearchQuerySnapshots(queryClient, snapshots);

    const restoredThread = queryClient.getQueryData(threadKey);
    const restoredDraftThread = queryClient.getQueryData(draftThreadKey);
    const laterVariant = queryClient.getQueryData(laterVariantKey);
    const removed = queryClient.getQueryData(removedKey);
    expect(restoredThread).toEqual(previousThread);
    expect(restoredDraftThread).toEqual(previousDraftThread);
    expect(laterVariant).toEqual(laterThread);
    expect(removed).toBeUndefined();
  });
});

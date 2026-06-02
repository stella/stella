import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

import type { InspectorTab } from "@/components/inspector/inspector-store";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import type { ChatThreadFetched } from "@/routes/_protected.chat/-queries";
import {
  chatKeys,
  invalidateChatThreadAcrossScopes,
} from "@/routes/_protected.chat/-queries";

type MaximizeContext = {
  activeOrganizationId: string;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: QueryClient;
};

/**
 * Build a "Move to main view" handler for a given inspector tab,
 * or `undefined` when the tab kind has no main-view counterpart.
 *
 * - Chat tabs land on `/chat/$threadId` (global) or
 *   `/chat/workspaces/$workspaceId/$threadId` (workspace).
 *   Cross-scope cache is invalidated so the destination doesn't
 *   read stale data; the inspector tab is closed afterwards.
 * - Task and PDF tabs are not maximized through this entry point
 *   (PDF has its own "open full view" button in the ribbon, task
 *   tabs have no full-page surface yet) — the helper returns
 *   `undefined` and the menu hides the item.
 */
export const buildMaximizeTabAction = (
  tab: InspectorTab,
  { activeOrganizationId, navigate, queryClient }: MaximizeContext,
): (() => void) | undefined => {
  if (tab.type !== "chat") {
    return undefined;
  }
  const tabWorkspaceId = tab.workspaceId;
  return () => {
    // The destination route shares this cache key with the inspector
    // tab — same scope, same threadId, same allowMissingThread — so
    // re-seeding here lets the destination's `useSuspenseQuery` read
    // the inspector's `Chat` instance and the picker's latest
    // `contextMatterIds` without going through the server. Without
    // this, an unsent chat moved to main loses its picked scope
    // because the server hasn't persisted the thread row yet and
    // would respond with an empty `contextMatterIds`.
    const threadKey =
      tabWorkspaceId === undefined
        ? chatKeys.thread(activeOrganizationId, {
            scope: "global",
            threadId: tab.id,
            allowMissingThread: true,
          })
        : chatKeys.thread(activeOrganizationId, {
            scope: "workspace",
            threadId: tab.id,
            workspaceId: tabWorkspaceId,
            allowMissingThread: true,
          });
    queryClient.setQueryData<ChatThreadFetched>(threadKey, (existing) =>
      existing
        ? { ...existing, contextMatterIds: tab.contextMatterIds }
        : existing,
    );
    void invalidateChatThreadAcrossScopes({
      queryClient,
      threadId: tab.id,
    });
    useInspectorStore.getState().closeTab(tab.id);
    if (tabWorkspaceId === undefined) {
      void navigate({
        to: "/chat/$threadId",
        params: { threadId: tab.id },
      });
      return;
    }
    void navigate({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: tabWorkspaceId, threadId: tab.id },
    });
  };
};

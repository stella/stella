import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

import {
  isCaseDecisionGenericTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { chatKeys } from "@/features/chat/chat-query-contract";
import type { ChatThreadFetched } from "@/features/chat/queries";
import { invalidateChatThreadAcrossScopes } from "@/features/chat/queries";
import { detached } from "@/lib/detached";

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
 * - Case-law decision tabs land on their public decision route.
 * - Task and PDF tabs are not maximized through this entry point
 *   (PDF has its own "open full view" button in the ribbon, task
 *   tabs have no full-page surface yet) — the helper returns
 *   `undefined` and the menu hides the item.
 */
export const buildMaximizeTabAction = (
  tab: InspectorTab,
  { activeOrganizationId, navigate, queryClient }: MaximizeContext,
): (() => void) | undefined => {
  if (isCaseDecisionGenericTab(tab)) {
    return () => {
      useInspectorTabsStore.getState().closeTab(tab.id);
      detached(
        navigateToCaseDecisionMain(navigate, tab.payload),
        "maximize-tab.navigate-case-decision",
      );
    };
  }
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
    detached(
      invalidateChatThreadAcrossScopes({
        queryClient,
        threadId: tab.id,
      }),
      "maximize-tab.invalidate-chat-thread-across-scopes",
    );
    useInspectorTabsStore.getState().closeTab(tab.id);
    if (tabWorkspaceId === undefined) {
      detached(
        navigate({
          to: "/chat/$threadId",
          params: { threadId: tab.id },
        }),
        "maximize-tab.navigate",
      );
      return;
    }
    detached(
      navigate({
        to: "/chat/workspaces/$workspaceId/$threadId",
        params: { workspaceId: tabWorkspaceId, threadId: tab.id },
      }),
      "maximize-tab.navigate",
    );
  };
};

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import {
  chatThreadTitleOptions,
  groupedChatThreadsOptions,
  invalidateChatThreadLists,
} from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

/**
 * The one web-side writer for a chat thread's title: PATCHes
 * `/chat/threads/:threadId/title`, optimistically patching the
 * grouped-threads and by-id title caches so every surface that shows the
 * title (sidebar, threads sheet, breadcrumb, overlay card) updates
 * immediately, and invalidating them on settle. Shared by every rename
 * affordance so the cache bookkeeping exists exactly once.
 */
export const useRenameChatThread = (threadRef: ChatThreadRef) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : undefined;
  const threadId = threadRef.threadId;

  const groupedKey = groupedChatThreadsOptions({
    activeOrganizationId,
  }).queryKey;
  // Only the typed query key is used here; `enabled: false` marks that this
  // options object never runs the query itself.
  const titleKey = chatThreadTitleOptions({
    activeOrganizationId,
    enabled: false,
    key: { threadId, workspaceId },
  }).queryKey;

  return useMutation({
    mutationFn: async (nextTitle: string) => {
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadId) })
        .title.patch(
          { title: nextTitle },
          {
            query: workspaceId
              ? { workspaceId: toSafeId<"workspace">(workspaceId) }
              : {},
          },
        );
      return unwrapEden(response);
    },
    onMutate: async (nextTitle) => {
      await queryClient.cancelQueries({ queryKey: groupedKey });
      await queryClient.cancelQueries({ queryKey: titleKey });
      const previous = queryClient.getQueryData(groupedKey);
      const previousTitle = queryClient.getQueryData(titleKey);
      queryClient.setQueryData(titleKey, nextTitle);
      queryClient.setQueryData(groupedKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                global: page.global.map((thread) =>
                  thread.id === threadId
                    ? { ...thread, title: nextTitle }
                    : thread,
                ),
                workspaces: page.workspaces.map((workspace) => ({
                  ...workspace,
                  threads: workspace.threads.map((thread) =>
                    thread.id === threadId
                      ? { ...thread, title: nextTitle }
                      : thread,
                  ),
                })),
              })),
            }
          : old,
      );
      return { previous, previousTitle };
    },
    onError: (error, _nextTitle, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(groupedKey, context.previous);
      }
      if (context?.previousTitle !== undefined) {
        queryClient.setQueryData(titleKey, context.previousTitle);
      } else {
        // The optimistic set created this cache entry; a rollback must
        // remove it, not leave the rejected title behind.
        queryClient.removeQueries({ queryKey: titleKey, exact: true });
      }
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSettled: () => {
      detached(
        invalidateChatThreadLists({ queryClient, workspaceId }),
        "use-rename-chat-thread.invalidate-chat-thread-lists",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: titleKey }),
        "use-rename-chat-thread.invalidate",
      );
    },
  });
};

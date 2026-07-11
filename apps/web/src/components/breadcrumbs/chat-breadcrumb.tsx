import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";
import { stellaToast } from "@stll/ui/components/toast";

import { useInlineRename } from "@/hooks/use-inline-rename";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import {
  chatThreadTitleOptions,
  groupedChatThreadsOptions,
  invalidateChatThreadLists,
  mergeGroupedChatThreadPages,
} from "@/routes/_protected.chat/-queries";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";

const protectedRoute = getRouteApi("/_protected");

// Thread-title crumb for chat routes. Reuses the grouped-threads list already
// primed by the sidebar / threads sheet (a lightweight query that never
// instantiates the chat runtime), narrowed with `select` to this thread's
// title. When the thread is not in the loaded pages (an older thread scrolled
// out of the window), a bounded by-id title read fills the gap instead of
// paging the whole list. Both queries use `useQuery`/`useInfiniteQuery` (not
// Suspense) so a cache miss cannot suspend the header. Falls back to the
// localized "New chat" while the thread is still untitled; the crumb updates
// once the list query invalidates.
//
// The crumb doubles as an inline rename affordance. Because this crumb IS the
// current route, clicking it has no navigation meaning, so a click activates
// in-place editing (Enter commits, Escape cancels) instead — the same
// `InlineEdit` + `useInlineRename` pair the inspector chat tab header uses. The
// commit optimistically patches the grouped-threads cache and invalidates it on
// settle, so every surface that reads the title (sidebar, threads sheet, this
// crumb) reflects the new name immediately.
export const ChatBreadcrumb = ({
  threadId,
  workspaceId,
}: {
  threadId: string;
  workspaceId?: string | undefined;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRoute.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: groupedTitle } = useInfiniteQuery({
    ...groupedChatThreadsOptions(activeOrganizationId),
    select: (data) => selectThreadTitle(data.pages, threadId),
  });

  // The grouped list only holds its first loaded pages, so an older thread that
  // has scrolled out of that window is absent (`groupedTitle === null`). Fall
  // back to a bounded by-id title read, enabled only on that miss so a thread
  // already in the list never triggers a redundant fetch.
  const titleOptions = chatThreadTitleOptions({
    activeOrganizationId,
    enabled: groupedTitle === null,
    key: { threadId, workspaceId },
  });
  const { data: byIdTitle } = useQuery(titleOptions);

  const title = groupedTitle ?? byIdTitle ?? null;
  const currentTitle = title && !isPlaceholderThreadTitle(title) ? title : "";
  const displayTitle =
    currentTitle.length > 0 ? currentTitle : t("chat.newChat");

  const groupedKey = groupedChatThreadsOptions(activeOrganizationId).queryKey;
  const titleKey = titleOptions.queryKey;
  const rename = useMutation({
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
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
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
      }
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSettled: () => {
      void invalidateChatThreadLists({ queryClient, workspaceId });
      void queryClient.invalidateQueries({ queryKey: titleKey });
    },
  });

  const inlineRename = useInlineRename({
    initial: currentTitle,
    onCommit: (value) => {
      rename.mutate(value);
    },
  });

  if (inlineRename.state.mode === "edit") {
    return (
      <BreadcrumbItem className="min-w-0 shrink">
        <InlineEdit
          inputClassName="w-48 text-xs"
          onCancel={inlineRename.cancel}
          onChange={inlineRename.setDraft}
          onCommit={() => {
            void inlineRename.commit();
          }}
          value={inlineRename.state.draft}
        />
      </BreadcrumbItem>
    );
  }

  return (
    <BreadcrumbItem className="min-w-0 shrink">
      <button
        className="hover:bg-accent hover:text-accent-foreground -mx-1 flex min-w-0 items-center rounded-sm px-1 py-0.5 transition-colors"
        onClick={() => inlineRename.startEditing()}
        title={t("chat.renameThread")}
        type="button"
      >
        <BidiText as="span" className="max-w-64 truncate">
          {displayTitle}
        </BidiText>
      </button>
    </BreadcrumbItem>
  );
};

type GroupedThreadsPages = Parameters<typeof mergeGroupedChatThreadPages>[0];

const selectThreadTitle = (
  pages: GroupedThreadsPages,
  threadId: string,
): string | null => {
  const { global, workspaces } = mergeGroupedChatThreadPages(pages);
  const globalMatch = global.find((thread) => thread.id === threadId);
  if (globalMatch) {
    return globalMatch.title;
  }
  for (const workspace of workspaces) {
    const match = workspace.threads.find((thread) => thread.id === threadId);
    if (match) {
      return match.title;
    }
  }
  return null;
};

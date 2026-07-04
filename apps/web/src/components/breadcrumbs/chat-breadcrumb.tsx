import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";

import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import {
  groupedChatThreadsOptions,
  mergeGroupedChatThreadPages,
} from "@/routes/_protected.chat/-queries";

const protectedRoute = getRouteApi("/_protected");

// Thread-title crumb for chat routes. Reuses the grouped-threads list already
// primed by the sidebar / threads sheet (a lightweight query that never
// instantiates the chat runtime), narrowed with `select` to this thread's
// title. `useInfiniteQuery` (not Suspense) keeps a cache miss from suspending
// the header. Falls back to the localized "New chat" while the thread is still
// untitled; the crumb updates once the list query invalidates.
export const ChatBreadcrumb = ({ threadId }: { threadId: string }) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRoute.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: title } = useInfiniteQuery({
    ...groupedChatThreadsOptions(activeOrganizationId),
    select: (data) => selectThreadTitle(data.pages, threadId),
  });

  const displayTitle =
    title && !isPlaceholderThreadTitle(title) ? title : t("chat.newChat");

  return (
    <BreadcrumbItem className="min-w-0 shrink">
      <BidiText as="span" className="max-w-64 truncate" title={displayTitle}>
        {displayTitle}
      </BidiText>
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

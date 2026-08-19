import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { BreadcrumbItem } from "@stll/ui/breadcrumb";

import { shouldFetchChatThreadTitle } from "@/components/breadcrumbs/chat-breadcrumb.logic";
import { ChatTitleRename } from "@/features/chat/components/chat-title-rename";
import {
  chatThreadOptions,
  chatThreadTitleOptions,
  groupedChatThreadsOptions,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";

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
// The crumb doubles as the chat route's rename affordance. Because this crumb
// IS the current route, clicking it has no navigation meaning, so a click
// activates in-place editing instead. The editing itself (InlineEdit, the
// suggest wand, the rename mutation, the `/rename-chat` subscription) lives
// in the shared `ChatTitleRename`; this file only resolves the title.
export const ChatBreadcrumb = ({
  threadId,
  workspaceId,
}: {
  threadId: string;
  workspaceId?: string | undefined;
}) => {
  const activeOrganizationId = protectedRoute.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: groupedThread } = useInfiniteQuery({
    ...groupedChatThreadsOptions({ activeOrganizationId }),
    select: (data) => selectThreadTitleSummary(data.pages, threadId),
  });

  // The route loader already primes this allow-missing query. Use its
  // activity timestamp as the existence signal for the title fallback: a
  // newly generated route id has no row yet, so issuing GET /title for it
  // would produce an expected but noisy 404. Once the first message exists,
  // the by-id title read is safe. Keep the query disabled when the grouped
  // list already supplied the title, preserving the no-extra-request path.
  const threadRef = workspaceId
    ? {
        scope: "workspace" as const,
        threadId: toChatThreadId(threadId),
        workspaceId,
      }
    : { scope: "global" as const, threadId: toChatThreadId(threadId) };
  const threadOptions = chatThreadOptions({
    activeOrganizationId,
    context: { allowMissingThread: true },
    key: threadRef,
  });
  const { data: threadData } = useQuery({
    ...threadOptions,
    enabled: groupedThread === null,
  });

  // The grouped list only holds its first loaded pages, so an older thread that
  // has scrolled out of that window is absent (`groupedThread === null`). Fall
  // back to a bounded by-id title read, enabled only on that miss so a thread
  // already in the list never triggers a redundant fetch.
  const titleOptions = chatThreadTitleOptions({
    activeOrganizationId,
    enabled: shouldFetchChatThreadTitle({
      groupedTitle: groupedThread?.title ?? null,
      threadExists: threadData?.threadExists,
    }),
    key: { threadId, workspaceId },
  });
  const { data: byIdTitle } = useQuery(titleOptions);

  const title = groupedThread?.title ?? byIdTitle ?? null;
  const currentTitle = title && !isPlaceholderThreadTitle(title) ? title : "";
  // A title resolved from the server means the thread is persisted (threads
  // are created on first send); otherwise fall back to the primed existence
  // signal for a persisted thread that is still on its placeholder title.
  const hasMessages = title !== null || threadData?.threadExists === true;
  const usedAnonymization =
    groupedThread?.usedAnonymization ?? threadData?.usedAnonymization ?? false;

  return (
    <BreadcrumbItem className="min-w-0 shrink">
      <ChatTitleRename
        hasMessages={hasMessages}
        inputClassName="w-48 text-xs"
        ownsRenameCommand
        threadRef={threadRef}
        title={currentTitle}
        usedAnonymization={usedAnonymization}
      />
    </BreadcrumbItem>
  );
};

type GroupedThreadsPages = Parameters<typeof mergeGroupedChatThreadPages>[0];
type ThreadTitleSummary = Pick<
  ReturnType<typeof mergeGroupedChatThreadPages>["global"][number],
  "title" | "usedAnonymization"
>;

const selectThreadTitleSummary = (
  pages: GroupedThreadsPages,
  threadId: string,
): ThreadTitleSummary | null => {
  const { global, workspaces } = mergeGroupedChatThreadPages(pages);
  const globalMatch = global.find((thread) => thread.id === threadId);
  if (globalMatch) {
    return {
      title: globalMatch.title,
      usedAnonymization: globalMatch.usedAnonymization,
    };
  }
  for (const workspace of workspaces) {
    const match = workspace.threads.find((thread) => thread.id === threadId);
    if (match) {
      return {
        title: match.title,
        usedAnonymization: match.usedAnonymization,
      };
    }
  }
  return null;
};

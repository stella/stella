import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/api-result";

import { parseRecentChatThreadsPage } from "./recent-chat-threads";

const CHAT_THREADS_PAGE_SIZE = 50;
const RECENT_CHAT_THREADS_STALE_TIME_MS = 5 * 60 * 1000;

type RecentChatThreadsKey = {
  activeOrganizationId: string;
};

const recentChatThreadKeys = {
  all: ["mobile", "chat-threads"] as const,
  recent: ({ activeOrganizationId }: RecentChatThreadsKey) =>
    [...recentChatThreadKeys.all, "recent", { activeOrganizationId }] as const,
};

const stringCursorSeed = (): string | undefined => undefined;

type FetchRecentChatThreadsPageOptions = {
  cursor?: string | undefined;
  signal: AbortSignal;
};

const fetchRecentChatThreadsPage = async ({
  cursor,
  signal,
}: FetchRecentChatThreadsPageOptions) => {
  const response = await api.chat.threads.get({
    fetch: { signal },
    query: {
      limit: CHAT_THREADS_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    },
  });

  return parseRecentChatThreadsPage(unwrapEden(response));
};

export const recentChatThreadsOptions = (activeOrganizationId: string) =>
  infiniteQueryOptions({
    queryKey: recentChatThreadKeys.recent({ activeOrganizationId }),
    staleTime: RECENT_CHAT_THREADS_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      await fetchRecentChatThreadsPage({ cursor: pageParam, signal }),
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

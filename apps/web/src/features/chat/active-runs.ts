import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { visitCursorPages } from "@/lib/infinite-query";

import { chatKeys } from "./chat-query-contract";

/** One page of the reader's open chats; the query reads them all. */
const ACTIVE_CHAT_RUNS_PAGE_SIZE = 100;

const fetchActiveChatRunsPage = async (
  signal: AbortSignal,
  cursor: string | undefined,
) => {
  const response = await api.chat.runs.active.get({
    fetch: { signal },
    query: {
      limit: ACTIVE_CHAT_RUNS_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    },
  });
  return unwrapApiResponse(response);
};

export type ActiveChatRun = Awaited<
  ReturnType<typeof fetchActiveChatRunsPage>
>["items"][number];

// The list orders waiting chats first, so stopping at one page would hide the
// working chats of a reader with many open.
const fetchActiveChatRuns = async (signal: AbortSignal) => {
  const runs: ActiveChatRun[] = [];
  await visitCursorPages({
    getPage: async (cursor) => await fetchActiveChatRunsPage(signal, cursor),
    visit: (page) => {
      runs.push(...page.items);
    },
  });
  return runs;
};

/**
 * The reader's chats that are working or waiting on them, in every matter.
 * The user event stream announces each change and a reconnect re-reads it,
 * so the cache stays fresh without polling.
 */
export const activeChatRunsOptions = ({
  activeOrganizationId,
  userId,
}: {
  activeOrganizationId: string;
  userId: string;
}) =>
  queryOptions({
    queryKey: chatKeys.activeRuns(activeOrganizationId, userId),
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => await fetchActiveChatRuns(signal),
  });

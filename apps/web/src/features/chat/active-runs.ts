import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";

import { chatKeys } from "./chat-query-contract";

/**
 * The most open chats one reader is expected to have at once, read in one
 * page. Matters past this count show what the page holds.
 */
const ACTIVE_CHAT_RUNS_LIMIT = 100;

const fetchActiveChatRuns = async (signal: AbortSignal) => {
  const response = await api.chat.runs.active.get({
    fetch: { signal },
    query: { limit: ACTIVE_CHAT_RUNS_LIMIT },
  });
  return unwrapApiResponse(response).items;
};

export type ActiveChatRun = Awaited<
  ReturnType<typeof fetchActiveChatRuns>
>[number];

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

import { queryOptions } from "@tanstack/react-query";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type ChatLimitReminderKey = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  userId: string;
};

const threadParams = (threadRef: ChatThreadRef) => ({
  threadId: toSafeId<"chatThread">(threadRef.threadId),
});

const scopeQuery = (threadRef: ChatThreadRef) =>
  threadRef.scope === "workspace"
    ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
    : {};

/**
 * Whether the member asked to hear when the usage limit that stopped this
 * chat's turn on their computer resets, and when that is.
 */
export const chatLimitReminderOptions = ({
  activeOrganizationId,
  threadRef,
  userId,
}: ChatLimitReminderKey) =>
  queryOptions({
    queryKey: chatKeys.limitReminder(
      activeOrganizationId,
      userId,
      getChatThreadKey(threadRef),
    ),
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api.chat.threads(threadParams(threadRef))["limit-reminder"].get({
          query: scopeQuery(threadRef),
          fetch: { signal },
        }),
      ),
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const setChatLimitReminder = async (threadRef: ChatThreadRef) => {
  const thread = api.chat.threads(threadParams(threadRef));
  return unwrapApiResponse(
    await thread["limit-reminder"].put(undefined, {
      query: scopeQuery(threadRef),
    }),
  );
};

export const cancelChatLimitReminder = async (threadRef: ChatThreadRef) => {
  const thread = api.chat.threads(threadParams(threadRef));
  return unwrapApiResponse(
    await thread["limit-reminder"].delete(undefined, {
      query: scopeQuery(threadRef),
    }),
  );
};

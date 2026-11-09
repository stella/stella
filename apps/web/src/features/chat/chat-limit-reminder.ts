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

const limitReminderEndpoint = (threadRef: ChatThreadRef) =>
  api.chat.threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })[
    "limit-reminder"
  ];

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
        await limitReminderEndpoint(threadRef).get({
          query: scopeQuery(threadRef),
          fetch: { signal },
        }),
      ),
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const setChatLimitReminder = async (threadRef: ChatThreadRef) =>
  unwrapApiResponse(
    await limitReminderEndpoint(threadRef).put(undefined, {
      query: scopeQuery(threadRef),
    }),
  );

export const cancelChatLimitReminder = async (threadRef: ChatThreadRef) =>
  unwrapApiResponse(
    await limitReminderEndpoint(threadRef).delete(undefined, {
      query: scopeQuery(threadRef),
    }),
  );

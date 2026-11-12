import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

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
  resourceQueryOptions(
    queryOptions({
      queryKey: chatKeys.limitReminder(
        activeOrganizationId,
        userId,
        getChatThreadKey(threadRef),
      ),
      queryFn: async ({ signal }) => {
        const thread = api.chat.threads(threadParams(threadRef));
        return unwrapApiResponse(
          await thread["limit-reminder"].get({
            query: scopeQuery(threadRef),
            fetch: { signal },
          }),
        );
      },
      staleTime: STALE_TIME.FIVE.MINUTES,
    }),
    // The member's own reminder on a chat; set and cancel refresh it.
    { resources: [RESOURCE_TYPE.CHAT_THREAD], scope: { type: "organization" } },
  );

/**
 * Only the member's own click sets or cancels a reminder, so these writes have
 * no automation capability.
 */
const SET_REMINDER = "chat.threads.limit-reminder.set";
const CANCEL_REMINDER = "chat.threads.limit-reminder.cancel";

export const setChatLimitReminder = async (threadRef: ChatThreadRef) => {
  const threadId = toSafeId<"chatThread">(threadRef.threadId);
  const query = scopeQuery(threadRef);
  return await invokeAppOnlyWrite(SET_REMINDER, async () =>
    unwrapApiResponse(
      await api.chat.threads({ threadId })["limit-reminder"].put(undefined, {
        query,
      }),
    ),
  );
};

export const cancelChatLimitReminder = async (threadRef: ChatThreadRef) => {
  const threadId = toSafeId<"chatThread">(threadRef.threadId);
  const query = scopeQuery(threadRef);
  return await invokeAppOnlyWrite(CANCEL_REMINDER, async () =>
    unwrapApiResponse(
      await api.chat.threads({ threadId })["limit-reminder"].delete(undefined, {
        query,
      }),
    ),
  );
};

import { queryOptions } from "@tanstack/react-query";

import type { ChatBackgroundTasks } from "@stll/api-contract/chat-background-tasks";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type ChatBackgroundTasksThread = {
  activeOrganizationId: string;
  userId: string;
  threadId: string;
};

/**
 * What the chat's coding agent left running in the background on the
 * member's computer. Read again when the user stream says a computer's
 * background work changed (`USER_EVENT_READ.CHAT_BACKGROUND_TASKS`).
 */
export const chatBackgroundTasksOptions = ({
  activeOrganizationId,
  userId,
  threadId,
}: ChatBackgroundTasksThread) =>
  queryOptions({
    queryKey: chatKeys.backgroundTasks(activeOrganizationId, userId, threadId),
    queryFn: async ({ signal }): Promise<ChatBackgroundTasks> => {
      const thread = api.chat.threads({
        threadId: toSafeId<"chatThread">(threadId),
      });
      return unwrapApiResponse(
        await thread["background-tasks"].get({ fetch: { signal } }),
      );
    },
  });

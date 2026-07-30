import { infiniteQueryOptions } from "@tanstack/react-query";

import { toSafeId } from "@stll/api/types";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/api-result";

export type MobileChatThreadRef =
  | { scope: "global"; threadId: string }
  | { scope: "workspace"; threadId: string; workspaceId: string };

export const mobileChatThreadOptions = (
  activeOrganizationId: string,
  ref: MobileChatThreadRef,
) =>
  infiniteQueryOptions({
    queryKey: ["mobile", "chat-thread", activeOrganizationId, ref] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const thread = api.chat.threads({
        threadId: toSafeId<"chatThread">(ref.threadId),
      });
      const scopeQuery =
        ref.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(ref.workspaceId) }
          : {};
      const response =
        pageParam === undefined
          ? await thread.messages.get({ fetch: { signal }, query: scopeQuery })
          : await thread.messages.older.get({
              fetch: { signal },
              query: { ...scopeQuery, before: pageParam },
            });

      const data = unwrapEden(response);
      return { messages: data.messages, olderCursor: data.olderCursor };
    },
    getNextPageParam: (lastPage) => lastPage.olderCursor ?? undefined,
  });

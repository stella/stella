import type {
  ChatThreadId,
  ChatThreadRef,
  ChatThreadRoute,
} from "@/lib/chat-thread-ref-types";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";

export type { ChatThreadId, ChatThreadRef, ChatThreadRoute };

export const getChatThreadKey = (threadRef: ChatThreadRef) =>
  threadRef.scope === "workspace"
    ? `workspace:${threadRef.workspaceId}:${threadRef.threadId}`
    : `global:${threadRef.threadId}`;

export const resolveChatContextMatterIds = (
  threadRef: ChatThreadRef,
  contextMatterIds: readonly string[],
): string[] => {
  if (threadRef.scope === "global") {
    return [...new Set(contextMatterIds)];
  }

  return [...new Set([threadRef.workspaceId, ...contextMatterIds])];
};

export const toChatThreadId = (value: string): ChatThreadId =>
  toSafeId<"chatThread">(value);

export const createChatThreadId = (): ChatThreadId =>
  toChatThreadId(createUuid());

export const chatThreadRoute = ({
  threadId,
  workspaceId,
}: {
  threadId: string;
  workspaceId?: string | null | undefined;
}): ChatThreadRoute =>
  workspaceId
    ? {
        to: "/chat/workspaces/$workspaceId/$threadId",
        params: { workspaceId, threadId },
      }
    : { to: "/chat/$threadId", params: { threadId } };

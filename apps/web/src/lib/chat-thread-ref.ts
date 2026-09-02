import { v7 as uuidv7 } from "uuid";

import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

export type ChatThreadId = SafeId<"chatThread">;

export type GlobalChatThreadRef = {
  scope: "global";
  threadId: ChatThreadId;
};

export type WorkspaceChatThreadRef = {
  scope: "workspace";
  threadId: ChatThreadId;
  workspaceId: string;
};

export type ChatThreadRef = GlobalChatThreadRef | WorkspaceChatThreadRef;

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

export const createChatThreadId = (): ChatThreadId => toChatThreadId(uuidv7());

/**
 * Route target for opening a chat thread: matter-scoped threads live under
 * their matter, global ones at the top level. One helper so every surface that
 * links to or navigates at a thread (search hits, fork provenance, the fork
 * action itself) picks the same pair, instead of each restating the two paths.
 */
export type ChatThreadRoute =
  | {
      to: "/chat/$threadId";
      params: { threadId: string };
    }
  | {
      to: "/chat/workspaces/$workspaceId/$threadId";
      params: { workspaceId: string; threadId: string };
    };

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

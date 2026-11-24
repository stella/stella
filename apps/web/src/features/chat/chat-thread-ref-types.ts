import type { SafeId } from "@/lib/safe-id";

export type ChatThreadId = SafeId<"chatThread">;

type GlobalChatThreadRef = {
  scope: "global";
  threadId: ChatThreadId;
};

type WorkspaceChatThreadRef = {
  scope: "workspace";
  threadId: ChatThreadId;
  workspaceId: string;
};

export type ChatThreadRef = GlobalChatThreadRef | WorkspaceChatThreadRef;

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

import type { GlobalSearchHit } from "@stll/api/types";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;

export type ChatHitRoute =
  | {
      to: "/chat/$threadId";
      params: { threadId: string };
    }
  | {
      to: "/chat/workspaces/$workspaceId/$threadId";
      params: { workspaceId: string; threadId: string };
    };

export const getChatHitRoute = (hit: ChatGlobalSearchHit): ChatHitRoute => {
  if (hit.workspaceId) {
    return {
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: hit.workspaceId, threadId: hit.threadId },
    };
  }

  return {
    to: "/chat/$threadId",
    params: { threadId: hit.threadId },
  };
};

export type GlobalChatThreadRef = {
  scope: "global";
  threadId: string;
};

export type WorkspaceChatThreadRef = {
  scope: "workspace";
  threadId: string;
  workspaceId: string;
};

export type ChatThreadRef = GlobalChatThreadRef | WorkspaceChatThreadRef;

export const getChatThreadKey = (threadRef: ChatThreadRef) =>
  threadRef.scope === "workspace"
    ? `workspace:${threadRef.workspaceId}:${threadRef.threadId}`
    : `global:${threadRef.threadId}`;

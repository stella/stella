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

export const toChatThreadId = (value: string): ChatThreadId =>
  toSafeId<"chatThread">(value);

export const createChatThreadId = (): ChatThreadId => toChatThreadId(uuidv7());

export const chatThreadIdFromFileFieldId = (fieldId: string): ChatThreadId =>
  toChatThreadId(fieldId);

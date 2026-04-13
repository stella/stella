/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import { getToolName, isToolUIPart } from "ai";

import type { ChatMessage, ChatPart, ChatUITools } from "@stella/api/types";

export type { ChatMessage, ChatPart, ChatUITools } from "@stella/api/types";
export type PersistedChatMessage = ChatMessage;
export type SharedChatUITools = Pick<ChatUITools, "ask-user">;
export type ApprovalToolName = "create-document" | "update-entity-fields";
export type ApprovalToolPart = Extract<
  ChatPart,
  { type: `tool-${ApprovalToolName}` }
>;
export type AskUserInput = SharedChatUITools["ask-user"]["input"];

/** Check if a tool part has an approval field (approval flow). */
export const isApprovalPart = (part: ChatPart): part is ApprovalToolPart => {
  if (!isToolUIPart(part)) {
    return false;
  }

  const toolName = getToolName(part);
  return toolName === "create-document" || toolName === "update-entity-fields";
};

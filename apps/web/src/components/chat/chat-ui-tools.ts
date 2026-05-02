/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import type { ChatMessage, ChatPart, ChatUITools } from "@stll/api/types";
import { getToolName, isToolUIPart } from "ai";

import type { TranslationKey } from "@/i18n/types";

export type { ChatMessage, ChatPart, ChatUITools } from "@stll/api/types";
export type PersistedChatMessage = ChatMessage;
export type SharedChatUITools = Pick<ChatUITools, "ask-user">;
export type AskUserOutput = SharedChatUITools["ask-user"]["output"];
export type ApprovalToolName = "create-document" | "update-entity-fields";
export type ApprovalToolPart = Extract<
  ChatPart,
  { type: `tool-${ApprovalToolName}` }
>;
export type AskUserInput = SharedChatUITools["ask-user"]["input"];

const CHAT_TOOL_TITLE_KEYS = {
  "ask-user": "chat.tool.ask-user",
  "create-document": "chat.tool.create-document",
  "describe-stella-function": "chat.tool.describe-stella-function",
  "execute-typescript": "chat.tool.execute-typescript",
  "load-skill": "chat.tool.load-skill",
  "read-contact": "chat.tool.read-contact",
  "read-content-across-matters": "chat.tool.read-content-across-matters",
  "read-skill-resource": "chat.tool.read-skill-resource",
  "search-across-matters": "chat.tool.search-across-matters",
  "update-entity-fields": "chat.tool.update-entity-fields",
} as const satisfies Record<keyof ChatUITools, TranslationKey>;

const UNKNOWN_CHAT_TOOL_TITLE_KEY =
  "chat.tool.unknown" satisfies TranslationKey;

export type ChatToolTitleKey =
  | (typeof CHAT_TOOL_TITLE_KEYS)[keyof typeof CHAT_TOOL_TITLE_KEYS]
  | typeof UNKNOWN_CHAT_TOOL_TITLE_KEY;

const isChatToolName = (
  toolName: string,
): toolName is keyof typeof CHAT_TOOL_TITLE_KEYS =>
  toolName in CHAT_TOOL_TITLE_KEYS;

export const getChatToolTitleKey = (toolName: string) => {
  if (isChatToolName(toolName)) {
    return CHAT_TOOL_TITLE_KEYS[toolName];
  }

  return UNKNOWN_CHAT_TOOL_TITLE_KEY;
};

/** Check if a tool part has an approval field (approval flow). */
export const isApprovalPart = (part: ChatPart): part is ApprovalToolPart => {
  if (!isToolUIPart(part)) {
    return false;
  }

  const toolName = getToolName(part);
  return toolName === "create-document" || toolName === "update-entity-fields";
};

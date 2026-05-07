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
export type ApprovalToolName =
  | "apply-active-docx-edits"
  | "create-document"
  | "update-entity-fields";
export type ApprovalToolPart = Extract<
  ChatPart,
  { type: `tool-${ApprovalToolName}` }
>;
export type ActiveDocxEditApprovalPart = Extract<
  ChatPart,
  { type: "tool-apply-active-docx-edits" }
>;
export type AskUserInput = SharedChatUITools["ask-user"]["input"];

const CHAT_TOOL_TITLE_KEYS = {
  "apply-active-docx-edits": "chat.tool.apply-active-docx-edits",
  ares_lookup_company: "chat.tool.ares_lookup_company",
  ares_search_companies: "chat.tool.ares_search_companies",
  "ask-user": "chat.tool.ask-user",
  "create-document": "chat.tool.create-document",
  "describe-stella-api": "chat.tool.describe-stella-api",
  "run-stella-query": "chat.tool.run-stella-query",
  "load-skill": "chat.tool.load-skill",
  "read-skill-resource": "chat.tool.read-skill-resource",
  "update-entity-fields": "chat.tool.update-entity-fields",
} as const satisfies Record<keyof ChatUITools, TranslationKey>;

const LEGACY_CHAT_TOOL_TITLE_KEYS = {
  "describe-stella-function": "chat.tool.describe-stella-function",
  "execute-typescript": "chat.tool.execute-typescript",
  "read-contact": "chat.tool.read-contact",
  "read-content-across-matters": "chat.tool.read-content-across-matters",
  "search-across-matters": "chat.tool.search-across-matters",
} as const satisfies Record<string, TranslationKey>;

const CHAT_TOOL_DISPLAY_TITLE_KEYS = {
  ...CHAT_TOOL_TITLE_KEYS,
  ...LEGACY_CHAT_TOOL_TITLE_KEYS,
} as const;

const UNKNOWN_CHAT_TOOL_TITLE_KEY =
  "chat.tool.unknown" satisfies TranslationKey;

export type ChatToolTitleKey =
  | (typeof CHAT_TOOL_DISPLAY_TITLE_KEYS)[keyof typeof CHAT_TOOL_DISPLAY_TITLE_KEYS]
  | typeof UNKNOWN_CHAT_TOOL_TITLE_KEY;

const isChatToolName = (
  toolName: string,
): toolName is keyof typeof CHAT_TOOL_DISPLAY_TITLE_KEYS =>
  toolName in CHAT_TOOL_DISPLAY_TITLE_KEYS;

export const getChatToolTitleKey = (toolName: string) => {
  if (isChatToolName(toolName)) {
    return CHAT_TOOL_DISPLAY_TITLE_KEYS[toolName];
  }

  return UNKNOWN_CHAT_TOOL_TITLE_KEY;
};

/** Check if a tool part has an approval field (approval flow). */
export const isApprovalPart = (part: ChatPart): part is ApprovalToolPart => {
  if (!isToolUIPart(part)) {
    return false;
  }

  const toolName = getToolName(part);
  return (
    toolName === "apply-active-docx-edits" ||
    toolName === "create-document" ||
    toolName === "update-entity-fields"
  );
};

export const isApprovedActiveDocxEditPart = (
  part: ChatPart,
): part is ActiveDocxEditApprovalPart & {
  approval: { approved: true; id: string };
  state: "approval-responded";
} =>
  part.type === "tool-apply-active-docx-edits" &&
  part.state === "approval-responded" &&
  part.approval.approved;

export const hasApprovedActiveDocxEditAwaitingClientOutput = ({
  messages,
}: {
  messages: PersistedChatMessage[];
}) => {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") {
    return false;
  }

  return message.parts.some(isApprovedActiveDocxEditPart);
};

export const getUserMessageHtmlHistory = (
  messages: readonly PersistedChatMessage[],
) => {
  const history: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (!message || message.role !== "user") {
      continue;
    }

    const textParts: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        textParts.push(part.text);
      }
    }

    const content = textParts.join("\n\n").trim();
    if (content) {
      history.push(content);
    }
  }

  return history;
};

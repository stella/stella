/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import type { ChatMessage, ChatPart, ChatUITools } from "@stll/api/types";

import type { TranslationKey } from "@/i18n/types";

export type { ChatMessage, ChatPart, ChatUITools } from "@stll/api/types";
export type PersistedChatMessage = ChatMessage;
export type SharedChatUITools = Pick<ChatUITools, "ask-user">;
export type AskUserOutput = SharedChatUITools["ask-user"]["output"];
type BuiltInApprovalToolName = Exclude<keyof ChatUITools, "ask-user">;
export type ApprovalToolName = BuiltInApprovalToolName | `mcp__${string}`;
const MCP_CONNECTOR_APPROVAL_GRANT_PREFIX = "mcp-connector:";
export type ToolApprovalGrant =
  | ApprovalToolName
  | `${typeof MCP_CONNECTOR_APPROVAL_GRANT_PREFIX}${string}`;
type DynamicApprovalToolPart = ChatPart & {
  type: "dynamic-tool";
  toolName: ApprovalToolName;
};
export type ApprovalToolPart =
  | Extract<ChatPart, { type: `tool-${ApprovalToolName}` }>
  | (ChatPart & { type: `tool-mcp__${string}` })
  | DynamicApprovalToolPart;
export type ActiveDocxEditApprovalPart = Extract<
  ChatPart,
  { type: "tool-apply-active-docx-edits" }
>;
export type AskUserInput = SharedChatUITools["ask-user"]["input"];
type PublicOfficialToolName = Extract<
  BuiltInApprovalToolName,
  "ares_lookup_company" | "ares_search_companies"
>;
const RUNNING_TOOL_STATES = {
  "input-available": true,
  "input-streaming": true,
} as const satisfies Record<string, true>;

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

const PUBLIC_OFFICIAL_CHAT_TOOL_NAMES = {
  ares_lookup_company: true,
  ares_search_companies: true,
} as const satisfies Record<PublicOfficialToolName, true>;

export const isExternalMcpToolName = (
  toolName: string,
): toolName is `mcp__${string}` => toolName.startsWith("mcp__");

export const getExternalMcpConnectorSlugFromToolName = (
  toolName: `mcp__${string}`,
): string | null => {
  const parts = toolName.split("__");
  return parts.length >= 3 ? (parts.at(1) ?? null) : null;
};

export const getExternalMcpConnectorApprovalGrant = (
  connectorSlug: string,
): ToolApprovalGrant =>
  `${MCP_CONNECTOR_APPROVAL_GRANT_PREFIX}${connectorSlug}`;

export const getToolApprovalGrant = (
  toolName: ApprovalToolName,
): ToolApprovalGrant => {
  if (!isExternalMcpToolName(toolName)) {
    return toolName;
  }

  const connectorSlug = getExternalMcpConnectorSlugFromToolName(toolName);
  if (!connectorSlug) {
    return toolName;
  }

  return getExternalMcpConnectorApprovalGrant(connectorSlug);
};

export const isToolApprovedByGrant = (
  grants: ReadonlySet<ToolApprovalGrant>,
  toolName: ApprovalToolName,
) => grants.has(toolName) || grants.has(getToolApprovalGrant(toolName));

export const isPublicOfficialChatToolName = (
  toolName: string,
): toolName is PublicOfficialToolName =>
  toolName in PUBLIC_OFFICIAL_CHAT_TOOL_NAMES;

export type ChatToolTitleKey =
  | (typeof CHAT_TOOL_DISPLAY_TITLE_KEYS)[keyof typeof CHAT_TOOL_DISPLAY_TITLE_KEYS]
  | typeof UNKNOWN_CHAT_TOOL_TITLE_KEY;

const isChatToolName = (
  toolName: string,
): toolName is keyof typeof CHAT_TOOL_DISPLAY_TITLE_KEYS =>
  toolName in CHAT_TOOL_DISPLAY_TITLE_KEYS;

export const isApprovalToolName = (
  toolName: string,
): toolName is ApprovalToolName => {
  if (isExternalMcpToolName(toolName)) {
    return true;
  }

  return isChatToolName(toolName) && toolName !== "ask-user";
};

export const isToolApprovalGrant = (
  value: string,
): value is ToolApprovalGrant =>
  isApprovalToolName(value) ||
  value.startsWith(MCP_CONNECTOR_APPROVAL_GRANT_PREFIX);

export const getChatToolTitleKey = (toolName: string) => {
  if (isChatToolName(toolName)) {
    return CHAT_TOOL_DISPLAY_TITLE_KEYS[toolName];
  }

  return UNKNOWN_CHAT_TOOL_TITLE_KEY;
};

const getToolNameFromPart = (part: unknown): string | null => {
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    typeof part.type !== "string"
  ) {
    return null;
  }

  if (part.type === "dynamic-tool") {
    if (!("toolName" in part) || typeof part.toolName !== "string") {
      return null;
    }

    return part.toolName;
  }

  if (!part.type.startsWith("tool-")) {
    return null;
  }

  return part.type.slice("tool-".length);
};

export const getApprovalToolName = (
  part: ApprovalToolPart,
): ApprovalToolName => {
  const toolName = getToolNameFromPart(part);
  if (toolName !== null && isApprovalToolName(toolName)) {
    return toolName;
  }

  throw new Error("Unsupported approval tool");
};

/** Check if a tool part has an approval field (approval flow). */
export const isApprovalPart = (part: unknown): part is ApprovalToolPart => {
  if (typeof part !== "object" || part === null) {
    return false;
  }

  const toolName = getToolNameFromPart(part);
  if (toolName === null || !isApprovalToolName(toolName)) {
    return false;
  }

  if (
    toolName === "apply-active-docx-edits" ||
    isExternalMcpToolName(toolName)
  ) {
    return true;
  }

  return "approval" in part;
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

export const isApprovalRespondedPart = (
  part: ChatPart,
): part is ApprovalToolPart & {
  approval: { approved: boolean; id: string };
  state: "approval-responded";
} =>
  isApprovalPart(part) &&
  part.state === "approval-responded" &&
  "approval" in part &&
  typeof part.approval === "object" &&
  part.approval !== null &&
  "id" in part.approval &&
  typeof part.approval.id === "string" &&
  "approved" in part.approval &&
  typeof part.approval.approved === "boolean";

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

export const hasApprovalResponseAwaitingModelStep = ({
  messages,
}: {
  messages: PersistedChatMessage[];
}) => {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") {
    return false;
  }

  return message.parts.some(isApprovalRespondedPart);
};

export const isRunningToolPart = (part: unknown): boolean => {
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    !("state" in part) ||
    typeof part.type !== "string" ||
    typeof part.state !== "string"
  ) {
    return false;
  }

  if (!(part.state in RUNNING_TOOL_STATES)) {
    return false;
  }

  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
};

export const hasRunningToolCallInLatestAssistantMessage = ({
  messages,
}: {
  messages: PersistedChatMessage[];
}) => {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") {
    return false;
  }

  return message.parts.some(isRunningToolPart);
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

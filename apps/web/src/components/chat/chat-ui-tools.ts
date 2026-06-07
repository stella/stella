/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import { panic } from "better-result";

import type { ChatMessage, ChatPart, ChatUITools } from "@stll/api/types";

import type { TranslationKey } from "@/i18n/types";

export type {
  ChatAnonRestoration,
  ChatMessage,
  ChatPart,
  ChatUITools,
} from "@stll/api/types";
export type PersistedChatMessage = ChatMessage;
export type SharedChatUITools = Pick<ChatUITools, "ask-user">;
export type AskUserOutput = SharedChatUITools["ask-user"]["output"];
// `create-document` is client-executed and uses the matter-pick UI as
// its gate, not the approval flow. Keep it out of the approval set so
// `NeedsMatterCard` renders instead of `ToolApprovalCard`.
type BuiltInApprovalToolName = Exclude<
  keyof ChatUITools,
  "ask-user" | "create-document"
>;
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
  | "boe_find_related_laws"
  | "boe_get_law"
  | "boe_get_law_block"
  | "boe_get_law_structure"
  | "boe_search_legislation"
  | "borme_get_summary"
  | "business_registry_lookup"
  | "infosoud_lookup_case"
>;
const RUNNING_TOOL_STATES = {
  "input-available": true,
  "input-streaming": true,
} as const satisfies Record<string, true>;
const USER_INPUT_TOOL_TYPES = {
  "tool-ask-user": true,
  "tool-create-document": true,
} as const satisfies Record<string, true>;

const CHAT_TOOL_TITLE_KEYS = {
  "apply-active-docx-edits": "chat.tool.apply-active-docx-edits",
  "ask-user": "chat.tool.ask-user",
  boe_find_related_laws: "chat.tool.boe_find_related_laws",
  boe_get_law: "chat.tool.boe_get_law",
  boe_get_law_block: "chat.tool.boe_get_law_block",
  boe_get_law_structure: "chat.tool.boe_get_law_structure",
  boe_search_legislation: "chat.tool.boe_search_legislation",
  borme_get_summary: "chat.tool.borme_get_summary",
  business_registry_lookup: "chat.tool.business_registry_lookup",
  "create-document": "chat.tool.create-document",
  "describe-stella-api": "chat.tool.describe-stella-api",
  "expand-chat-history": "chat.tool.expand-chat-history",
  fetch_url: "chat.tool.fetch_url",
  infosoud_lookup_case: "chat.tool.infosoud_lookup_case",
  "run-stella-query": "chat.tool.run-stella-query",
  "load-skill": "chat.tool.load-skill",
  "read-skill-resource": "chat.tool.read-skill-resource",
  "search-chat-history": "chat.tool.search-chat-history",
  "update-entity-fields": "chat.tool.update-entity-fields",
  web_search: "chat.tool.web_search",
} as const satisfies Record<keyof ChatUITools, TranslationKey>;

// Tools that used to be registered but were replaced by the unified
// `business_registry_lookup` (or removed for other reasons). Keep
// title keys around so historical chat history still renders with a
// recognisable label rather than the generic "unknown" fallback.
const LEGACY_CHAT_TOOL_TITLE_KEYS = {
  ares_lookup_company: "chat.tool.ares_lookup_company",
  ares_search_companies: "chat.tool.ares_search_companies",
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
  boe_find_related_laws: true,
  boe_get_law: true,
  boe_get_law_block: true,
  boe_get_law_structure: true,
  boe_search_legislation: true,
  borme_get_summary: true,
  business_registry_lookup: true,
  infosoud_lookup_case: true,
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

  return (
    isChatToolName(toolName) &&
    toolName !== "ask-user" &&
    toolName !== "create-document"
  );
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

  return panic("Unsupported approval tool");
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

  if (part.type in USER_INPUT_TOOL_TYPES) {
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

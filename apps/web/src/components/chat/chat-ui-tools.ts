/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import type { ChatClientState, UIMessage } from "@tanstack/ai-client";
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
export type ChatAttachmentPart = Extract<
  ChatPart,
  { type: "document" | "image" }
> & {
  metadata?: {
    filename?: string | undefined;
    placeholder?: string | undefined;
  };
};
export type ChatClientTools =
  ChatMessage extends UIMessage<infer TTools> ? TTools : never;
export type ChatMessageMetadata = NonNullable<ChatMessage["metadata"]>;
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
export type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
export type ApprovalToolPart = ChatToolCallPart & {
  name: ApprovalToolName;
  approval: {
    approved?: boolean | undefined;
    id: string;
    needsApproval: boolean;
  };
};
export type ActiveDocxEditApprovalPart = ApprovalToolPart & {
  name: "apply-active-docx-edits";
};
export type AskUserInput = SharedChatUITools["ask-user"]["input"];
type PublicOfficialToolName = Extract<
  BuiltInApprovalToolName,
  | "boe_find_related_laws"
  | "boe_get_law"
  | "boe_get_law_block"
  | "boe_get_law_structure"
  | "borme_get_summary"
  | "business_registry_lookup"
  | "infosoud_lookup_case"
>;
type ExternalInputToolName = Extract<
  BuiltInApprovalToolName,
  "boe_search_legislation" | "fetch_url" | "web_search"
>;
const RUNNING_TOOL_STATES = {
  "awaiting-input": true,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<string, true>;
const USER_INPUT_TOOL_NAMES = {
  "ask-user": true,
  "create-document": true,
} as const satisfies Record<string, true>;

// Mirrors the `@stll/folio-agents` tool names registered server-side in
// `apps/api/src/handlers/chat/tools/folio-agent-tools.ts` (`READ_DOCUMENT_TOOL_NAME`
// / `FIND_TEXT_TOOL_NAME`). Kept as local literals rather than a runtime import from
// `@stll/api` — this file already follows that pattern for other built-in tool names.
const READ_DOCUMENT_TOOL_NAME = "read_document";
const FIND_TEXT_TOOL_NAME = "find_text";
const READ_CHANGES_TOOL_NAME = "read_changes";
const READ_COMMENTS_TOOL_NAME = "read_comments";
// Read-only folio-agents tools the file overlay auto-runs against the live
// editor bridge (no approval). The comment MUTATION tools (`add_comment`,
// `reply_comment`, `resolve_comment`) are deliberately NOT here: they carry
// `needsApproval` and are resolved through the approval flow, not this
// auto-run watcher.
const FOLIO_AGENT_DOC_TOOL_NAMES = {
  [FIND_TEXT_TOOL_NAME]: true,
  [READ_CHANGES_TOOL_NAME]: true,
  [READ_COMMENTS_TOOL_NAME]: true,
  [READ_DOCUMENT_TOOL_NAME]: true,
} as const satisfies Record<string, true>;

const CHAT_TOOL_TITLE_KEYS = {
  add_comment: "chat.tool.add_comment",
  "apply-active-docx-edits": "chat.tool.apply-active-docx-edits",
  "ask-user": "chat.tool.ask-user",
  boe_find_related_laws: "chat.tool.boe_find_related_laws",
  boe_get_law: "chat.tool.boe_get_law",
  boe_get_law_block: "chat.tool.boe_get_law_block",
  boe_get_law_structure: "chat.tool.boe_get_law_structure",
  boe_search_legislation: "chat.tool.boe_search_legislation",
  borme_get_summary: "chat.tool.borme_get_summary",
  business_registry_lookup: "chat.tool.business_registry_lookup",
  compare_versions: "chat.tool.compare_versions",
  "create-document": "chat.tool.create-document",
  "create-current-skill-resource": "common.edit",
  delete_clause: "chat.tool.delete_clause",
  delete_contact: "chat.tool.delete_contact",
  delete_document: "chat.tool.delete_document",
  delete_matter: "chat.tool.delete_matter",
  delete_time_entry: "chat.tool.delete_time_entry",
  describe_template: "chat.tool.describe_template",
  // Code-mode discovery companion to execute_typescript: fetches a read tool's
  // full signature on demand.
  discover_tools: "chat.tool.discover_tools",
  // Code-mode sandbox runner (replaces run-stella-query).
  execute_typescript: "chat.tool.execute_typescript",
  "expand-chat-history": "chat.tool.expand-chat-history",
  fetch_url: "chat.tool.fetch_url",
  fill_template: "chat.tool.fill_template",
  find_text: "chat.tool.find_text",
  infosoud_lookup_case: "chat.tool.infosoud_lookup_case",
  link_matter_contact: "chat.tool.link_matter_contact",
  list_templates: "chat.tool.list_templates",
  manage_organization: "chat.tool.manage_organization",
  run_playbook: "chat.tool.run_playbook",
  save_clause: "chat.tool.save_clause",
  save_contact: "chat.tool.save_contact",
  save_document: "chat.tool.save_document",
  save_matter: "chat.tool.save_matter",
  save_task: "chat.tool.save_task",
  save_template: "chat.tool.save_template",
  save_time_entry: "chat.tool.save_time_entry",
  set_field_value: "chat.tool.set_field_value",
  set_practice_jurisdictions: "chat.tool.set_practice_jurisdictions",
  spawn_subagents: "chat.tool.spawn_subagents",
  suggest_template_fields: "chat.tool.suggest_template_fields",
  "load-skill": "chat.tool.load-skill",
  read_changes: "chat.tool.read_changes",
  read_comments: "chat.tool.read_comments",
  read_document: "chat.tool.read_document",
  reply_comment: "chat.tool.reply_comment",
  resolve_comment: "chat.tool.resolve_comment",
  "read-skill-resource": "chat.tool.read-skill-resource",
  "search-chat-history": "chat.tool.search-chat-history",
  "update-current-skill-body": "common.edit",
  "update-current-skill-resource": "common.edit",
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
  // Retired hand-rolled code-execution tools, replaced by the code-mode
  // execute_typescript / discover_tools pair. Kept so historical threads that
  // reference them still render a recognisable label.
  "describe-stella-api": "chat.tool.describe-stella-api",
  "describe-stella-function": "chat.tool.describe-stella-function",
  "execute-typescript": "chat.tool.execute-typescript",
  "read-contact": "chat.tool.read-contact",
  "read-content-across-matters": "chat.tool.read-content-across-matters",
  "run-stella-query": "chat.tool.run-stella-query",
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
  borme_get_summary: true,
  business_registry_lookup: true,
  infosoud_lookup_case: true,
} as const satisfies Record<PublicOfficialToolName, true>;

const EXTERNAL_INPUT_CHAT_TOOL_NAMES = {
  boe_search_legislation: true,
  fetch_url: true,
  web_search: true,
} as const satisfies Record<ExternalInputToolName, true>;

export const isExternalMcpToolName = (
  toolName: string,
): toolName is `mcp__${string}` => toolName.startsWith("mcp__");

export const isExternalInputChatToolName = (
  toolName: ApprovalToolName,
): toolName is ExternalInputToolName =>
  toolName in EXTERNAL_INPUT_CHAT_TOOL_NAMES;

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

/** Prefix marking a destructive (irreversible delete) registry write tool. */
const DESTRUCTIVE_CHAT_TOOL_NAME_PREFIX = "delete_";
const APPROVAL_ONCE_CHAT_TOOL_NAMES = {
  manage_organization: true,
} as const satisfies Partial<Record<ApprovalToolName, true>>;

/**
 * Whether a chat tool is destructive (an irreversible delete). Destructive
 * writes may only be approved once or denied — never "allow in conversation"
 * or "always allow" — so a stored grant can never auto-approve a delete.
 *
 * The `delete_` prefix is a GUARDED convention, not a loose heuristic: an
 * api-side test (registry-quality suite) asserts that in the MCP registry every
 * `access: "write"` tool with `annotations.destructiveHint` is named `delete_*`
 * and every `delete_*` tool carries `destructiveHint`, so this frontend check
 * cannot silently drift from the registry's own destructive classification.
 */
export const isDestructiveChatToolName = (toolName: string): boolean =>
  toolName.startsWith(DESTRUCTIVE_CHAT_TOOL_NAME_PREFIX);

export const isApprovalOnceChatToolName = (toolName: ApprovalToolName) =>
  isDestructiveChatToolName(toolName) ||
  toolName in APPROVAL_ONCE_CHAT_TOOL_NAMES;

/**
 * Chat tools that may only ever be approved once or denied — never granted
 * "allow in conversation" or "always allow". Delegation (`spawn_subagents`)
 * kicks off a whole subagent write-loop per call, so unlike a single
 * mutation it must be reviewed every time rather than covered by a stored
 * grant.
 */
export const isNonPersistentGrantChatToolName = (toolName: string): boolean =>
  toolName === "spawn_subagents";

/**
 * Chat tools whose approval card renders the shared registry-write summary
 * (readable key/value rows, refs shown as chat refs, long values truncated).
 * Covers the registry write projections plus `fill_template` (served by the
 * hand-written template tool). Validated against `keyof ChatUITools` so a
 * renamed tool fails typecheck here.
 */
const REGISTRY_WRITE_SUMMARY_TOOL_NAMES = {
  delete_clause: true,
  delete_contact: true,
  delete_document: true,
  delete_matter: true,
  delete_time_entry: true,
  fill_template: true,
  link_matter_contact: true,
  manage_organization: true,
  run_playbook: true,
  save_clause: true,
  save_contact: true,
  save_document: true,
  save_matter: true,
  save_task: true,
  save_template: true,
  save_time_entry: true,
  set_field_value: true,
  set_practice_jurisdictions: true,
} as const satisfies Partial<Record<keyof ChatUITools, true>>;

export const isRegistryWriteSummaryToolName = (toolName: string): boolean =>
  Object.hasOwn(REGISTRY_WRITE_SUMMARY_TOOL_NAMES, toolName);

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

  if (part.type !== "tool-call") {
    return null;
  }

  if (!("name" in part) || typeof part.name !== "string") {
    return null;
  }

  return part.name;
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

  return (
    "approval" in part &&
    typeof part.approval === "object" &&
    part.approval !== null &&
    "id" in part.approval &&
    typeof part.approval.id === "string" &&
    "needsApproval" in part.approval &&
    typeof part.approval.needsApproval === "boolean"
  );
};

type ApplyActiveDocxEditsToolInput =
  ChatUITools["apply-active-docx-edits"]["input"];

export const isApplyActiveDocxEditsInput = (
  input: unknown,
): input is ApplyActiveDocxEditsToolInput =>
  typeof input === "object" &&
  input !== null &&
  "operations" in input &&
  Array.isArray(input.operations);

/**
 * Latest apply-active-docx-edits part matching the given approval id
 * (newest message first). Used by the surfaces that client-execute
 * the tool (file overlay, Template Studio) to recover the operations
 * the user just approved.
 */
export const getActiveDocxEditApprovalPart = (
  messages: PersistedChatMessage[],
  approvalId: string,
):
  | (ActiveDocxEditApprovalPart & { input: ApplyActiveDocxEditsToolInput })
  | null => {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages.at(messageIndex);
    if (!message || message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (!isApprovalPart(part) || part.name !== "apply-active-docx-edits") {
        continue;
      }

      const input = part.input;
      if (
        (part.state === "approval-requested" ||
          part.state === "approval-responded") &&
        part.approval.id === approvalId &&
        isApplyActiveDocxEditsInput(input)
      ) {
        return { ...part, input };
      }
    }
  }

  return null;
};

export const isApprovedActiveDocxEditPart = (
  part: ChatPart,
): part is ActiveDocxEditApprovalPart & {
  approval: { approved: true; id: string; needsApproval: boolean };
  state: "approval-responded";
} =>
  part.type === "tool-call" &&
  part.name === "apply-active-docx-edits" &&
  part.state === "approval-responded" &&
  part.approval?.approved === true;

export const isApprovalRespondedPart = (
  part: ChatPart,
): part is ApprovalToolPart & {
  approval: { approved: boolean; id: string; needsApproval: boolean };
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

  if (part.type !== "tool-call" || !("name" in part)) {
    return false;
  }

  if (!(part.state in RUNNING_TOOL_STATES)) {
    return false;
  }

  if (typeof part.name !== "string" || part.name in USER_INPUT_TOOL_NAMES) {
    return false;
  }

  return true;
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

/**
 * An unresolved `read_document` / `find_text` tool-call part, narrowed by
 * {@link isUnresolvedFolioAgentDocToolCallPart}.
 */
export type UnresolvedFolioAgentDocToolCallPart = ChatToolCallPart & {
  name: keyof typeof FOLIO_AGENT_DOC_TOOL_NAMES;
  state: "input-complete";
};

/**
 * A `read_document` / `find_text` tool-call part whose input has fully
 * streamed in but that has not yet been answered with a result.
 *
 * These two tools (from `@stll/folio-agents`) are client-executed and
 * carry no `needsApproval` gate, so nothing else resolves them — the file
 * overlay's auto-run watcher (`file-chat-overlay.tsx`) uses this predicate
 * to find calls it still needs to execute against the live editor and
 * answer via `addToolResult`.
 */
export const isUnresolvedFolioAgentDocToolCallPart = (
  part: unknown,
): part is UnresolvedFolioAgentDocToolCallPart => {
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

  if (part.type !== "tool-call" || part.state !== "input-complete") {
    return false;
  }

  return (
    "name" in part &&
    typeof part.name === "string" &&
    part.name in FOLIO_AGENT_DOC_TOOL_NAMES
  );
};

/**
 * Core decision loop for the file overlay's folio-agents doc-tool auto-run
 * watcher: which parts in the latest assistant message still need a
 * client-executed result.
 *
 * Pure and colocated with {@link isUnresolvedFolioAgentDocToolCallPart} so
 * the effect in `file-chat-overlay.tsx` stays a thin dispatch loop — it
 * only needs to call this, mark the returned ids as executed, and fire the
 * tool call for each. `executedIds` excludes parts the watcher has already
 * dispatched itself in a prior render (tracked in a ref there; there is no
 * approval click to gate re-entrancy the way the DOCX-edit approval flow
 * has).
 */
export const selectUnresolvedFolioAgentDocToolCallParts = (
  messageParts: readonly ChatPart[],
  executedIds: ReadonlySet<string>,
): UnresolvedFolioAgentDocToolCallPart[] =>
  messageParts.filter(
    (part): part is UnresolvedFolioAgentDocToolCallPart =>
      isUnresolvedFolioAgentDocToolCallPart(part) && !executedIds.has(part.id),
  );

/**
 * An `apply-active-docx-edits` tool-call part whose input has fully
 * streamed in but that has not yet been answered with a result.
 *
 * The tool carries no `needsApproval` gate (it only queues suggestions
 * into the client review panel — it never writes to the document), so
 * like the folio-agents read tools nothing else resolves it. The file
 * overlay's auto-run watcher finds these and answers them via
 * `addToolResult` after queuing the suggestions.
 */
export type UnresolvedActiveDocxEditToolCallPart = ChatToolCallPart & {
  name: "apply-active-docx-edits";
  state: "input-complete";
};

export const isUnresolvedActiveDocxEditToolCallPart = (
  part: unknown,
): part is UnresolvedActiveDocxEditToolCallPart => {
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

  if (part.type !== "tool-call" || part.state !== "input-complete") {
    return false;
  }

  return "name" in part && part.name === "apply-active-docx-edits";
};

/**
 * Core decision loop for the file overlay's active-DOCX-edit auto-run
 * watcher: which `apply-active-docx-edits` parts in the latest assistant
 * message still need a client-executed (queue-only) result. Pure and
 * colocated with {@link isUnresolvedActiveDocxEditToolCallPart} so the
 * effect stays a thin dispatch loop. `executedIds` excludes parts the
 * watcher has already dispatched itself in a prior render.
 */
export const selectUnresolvedActiveDocxEditToolCallParts = (
  messageParts: readonly ChatPart[],
  executedIds: ReadonlySet<string>,
): UnresolvedActiveDocxEditToolCallPart[] =>
  messageParts.filter(
    (part): part is UnresolvedActiveDocxEditToolCallPart =>
      isUnresolvedActiveDocxEditToolCallPart(part) && !executedIds.has(part.id),
  );

// Terminal state a dead running tool-call part is rewritten to at
// hydration. "error" is the SDK's own terminal state for a failed tool
// call: it clears `isRunningToolPart` and renders the card as interrupted
// rather than a perpetual spinner. It never round-trips to the server —
// only `messages.at(-1)` is sent on a send, and a sanitized assistant part
// is never that message.
const INTERRUPTED_TOOL_CALL_STATE = "error" as const;

const toTerminalIfRunningToolPart = (part: ChatPart): ChatPart => {
  if (part.type !== "tool-call" || !isRunningToolPart(part)) {
    return part;
  }
  return { ...part, state: INTERRUPTED_TOOL_CALL_STATE };
};

/**
 * Rewrite running tool-call parts that can no longer complete into a
 * terminal errored state, clearing `isRunningToolPart` — and therefore
 * `hasRunningToolCallInLatestAssistantMessage` / `isGenerating` — so the
 * composer leaves its stop/spinner state instead of wedging there forever.
 *
 * Applied on the two triggers that strand a tool part mid-run with no event
 * that would ever finalize it:
 *
 *  - Hydration from persistence: the server only persists finalized turns
 *    (written at stream end, not mid-stream), so any running tool-call part
 *    in server-loaded messages belongs to a turn whose stream died before
 *    finishing (API restart / deploy / crash mid tool call).
 *  - Explicit stop: the AI SDK's `stop()` aborts the live request but never
 *    rewrites message parts, so a tool part caught mid-input would keep the
 *    turn "generating" forever. The runtime's `stop` applies this right
 *    after aborting.
 *
 * `ask-user` / `create-document` and approval-flow parts are long-lived by
 * design and already excluded by `isRunningToolPart`. Messages and parts
 * left unchanged are returned by reference so downstream memoization stays
 * stable.
 */
export const sanitizeRunningToolCalls = (
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = message.parts.map(toTerminalIfRunningToolPart);
    const partsChanged = parts.some(
      (part, index) => part !== message.parts[index],
    );
    return partsChanged ? { ...message, parts } : message;
  });

type ChatTurnInFlightOptions = {
  status: ChatClientState;
  messages: PersistedChatMessage[];
  /**
   * Set when the user explicitly stopped the turn. The AI SDK's
   * `stop()` only aborts a live request; it never rewrites message
   * parts, so a tool part caught mid-input stays in a running state
   * and would otherwise keep the turn "in flight" forever.
   */
  turnAbandoned?: boolean;
};

/**
 * Whether a chat turn is still in flight: an active request, or a
 * tool call on the latest assistant message that is still collecting
 * input or awaiting its output (the windows between response streams
 * in multi-step tool turns).
 *
 * An errored turn is never in flight. When the stream dies mid tool
 * call (network drop, server restart) the AI SDK flips its status to
 * `"error"` but leaves the partial tool part in a running state; the
 * SDK never auto-continues after an error, so treating that tail as
 * in-flight would wedge the session as "generating" until reload.
 */
export const isChatTurnInFlight = ({
  status,
  messages,
  turnAbandoned = false,
}: ChatTurnInFlightOptions): boolean => {
  if (status === "submitted" || status === "streaming") {
    return true;
  }
  if (status === "error" || turnAbandoned) {
    return false;
  }
  return hasRunningToolCallInLatestAssistantMessage({ messages });
};

/**
 * Parse a completed tool-call part's raw `arguments` JSON.
 *
 * Arguments stream in incrementally, so the part carries no usable
 * payload while it is `awaiting-input` / `input-streaming`; parsing is
 * skipped for those states. Invalid or empty JSON yields `undefined`
 * rather than throwing (JSON boundary, so a local try/catch is fine).
 */
export const parseCompletedToolCallArguments = (
  part: ChatToolCallPart,
): unknown => {
  if (part.state === "awaiting-input" || part.state === "input-streaming") {
    return undefined;
  }
  const raw = part.arguments.trim();
  if (raw.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return undefined;
  }
};

const withParsedToolCallInput = (part: ChatPart): ChatPart => {
  if (part.type !== "tool-call" || part.input !== undefined) {
    return part;
  }
  const input = parseCompletedToolCallArguments(part);
  if (input === undefined) {
    return part;
  }
  const withInput = { ...part, input };
  return isRegisteredToolCallWithInput(withInput) ? withInput : part;
};

const isRegisteredToolCallWithInput = (
  value: unknown,
): value is ChatToolCallPart => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "tool-call" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("input" in value)
  ) {
    return false;
  }
  return isChatToolName(value.name) && isJsonObject(value.input);
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Fill each tool-call part's typed `input` from its raw `arguments`.
 *
 * TanStack's stream processor and its persisted-message projection
 * only ever populate `arguments` (the raw JSON string) on a tool-call
 * part; `input` is optional at the type level and never set at runtime
 * (the parsed value stays inside the processor as `parsedArguments`).
 * Reading `part.input` directly therefore always yields `undefined` —
 * identically in live streaming, transcript re-send, and reload from
 * persistence.
 *
 * Deriving `input` here, once, at the single point where messages
 * leave the chat runtime for the UI (`useChatSession`), gives every
 * consumer (ask-user / create-document / approval cards, generic
 * tool-call card, active-DOCX-edit recovery) a parsed `input` without
 * scattering `JSON.parse` across components. Messages and parts that
 * need no change are returned by reference so downstream memoization
 * and referential-equality checks stay stable.
 */
export const withParsedToolCallInputs = (
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] =>
  messages.map((message) => {
    const parts = message.parts.map(withParsedToolCallInput);
    const partsChanged = parts.some(
      (part, index) => part !== message.parts[index],
    );
    return partsChanged ? { ...message, parts } : message;
  });

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
      if (part.type === "text" && part.content.trim()) {
        textParts.push(part.content);
      }
    }

    const content = textParts.join("\n\n").trim();
    if (content) {
      history.push(content);
    }
  }

  return history;
};

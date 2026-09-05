/**
 * Re-exports chat message types from the backend (single
 * source of truth) and provides frontend-only helpers.
 */

import type { ChatClientState, UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";

import { FOLIO_AGENT_TOOL_NAMES } from "@stll/folio-agents";
import type { FolioAgentToolName } from "@stll/folio-agents";

import type { TranslationKey } from "@/i18n/types";
import type {
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
  ChatMessage,
  ChatPart as TanStackChatPart,
  ChatUITools,
} from "@/lib/api-contract";

export type {
  ChatAnonRestoration,
  ChatMessage,
  ChatUITools,
} from "@/lib/api-contract";
export type ChatPart = TanStackChatPart;
export type PersistedChatMessage = ChatMessage;
type TanStackChatToolCallPart = Extract<
  TanStackChatPart,
  { type: "tool-call" }
>;
type BuiltInChatToolName = keyof BuiltInChatToolPolicyKindByName;
type BuiltInChatToolCallPart = {
  [TName in BuiltInChatToolName]: Omit<
    Extract<TanStackChatToolCallPart, { name: TName }>,
    "input" | "output"
  > & {
    input?: ChatUITools[TName]["input"];
    output?: ChatUITools[TName]["output"];
  };
}[BuiltInChatToolName];
type ExternalMcpChatToolCallPart = Extract<
  TanStackChatToolCallPart,
  { name: `mcp__${string}` }
>;
declare const opaquePersistedChatToolCallProof: unique symbol;
/**
 * Proof assigned after a persisted tool call passes the protocol-shape guard
 * and its name is confirmed absent from both current tool namespaces.
 */
export type OpaquePersistedChatToolCallPart = TanStackChatToolCallPart & {
  readonly [opaquePersistedChatToolCallProof]: true;
};

/**
 * TanStack deliberately leaves JSON-schema tool payloads unknown. At Stella's
 * rendering boundary, built-in payloads retain the types derived from the same
 * Standard Schema tool map; external MCP and opaque historical payloads remain
 * unknown.
 */
export type RegisteredChatUIToolCallPart =
  | BuiltInChatToolCallPart
  | ExternalMcpChatToolCallPart;
type RegisteredFolioAgentToolName = Extract<
  keyof ChatUITools,
  FolioAgentToolName
>;
export type RegisteredFolioAgentToolCallPart<
  TName extends RegisteredFolioAgentToolName = RegisteredFolioAgentToolName,
> = {
  [TCurrentName in TName]: Extract<
    RegisteredChatUIToolCallPart,
    { name: TCurrentName }
  > & {
    input: ChatUITools[TCurrentName]["input"];
  };
}[TName];
export type ChatUIToolCallPart =
  | RegisteredChatUIToolCallPart
  | OpaquePersistedChatToolCallPart;
export type ChatUIPart =
  | Exclude<TanStackChatPart, { type: "tool-call" }>
  | ChatUIToolCallPart;
export type ChatUIMessage = Omit<ChatMessage, "parts"> & {
  parts: ChatUIPart[];
};
export type ChatToolCallPart = TanStackChatToolCallPart;
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
// `create-document` is client-executed and renders its own draft UI, not the
// approval flow. Keep it out of the approval set so `NeedsMatterCard` renders
// instead of `ToolApprovalCard`.
type BuiltInApprovalToolName = Exclude<
  keyof ChatUITools,
  "ask-user" | "create-document"
>;
export type ApprovalToolName = BuiltInApprovalToolName | `mcp__${string}`;
const MCP_CONNECTOR_APPROVAL_GRANT_PREFIX = "mcp-connector:";
export type ToolApprovalGrant =
  | ApprovalToolName
  | `${typeof MCP_CONNECTOR_APPROVAL_GRANT_PREFIX}${string}`;
export type ApprovalToolPart = RegisteredChatUIToolCallPart & {
  name: ApprovalToolName;
  approval: {
    approved?: boolean | undefined;
    id: string;
    needsApproval: boolean;
  };
};
export type AskUserInput = SharedChatUITools["ask-user"]["input"];
// Built-in tool names whose backend policy kind is `K`, derived from
// `BuiltInChatToolPolicyKindByName` (the backend's single source of truth
// for tool classification) instead of hand-listed, so a backend
// reclassification (e.g. a tool moving off `public_official`) breaks
// typecheck here rather than silently keeping stale frontend behavior.
type ToolNameWithPolicyKind<K extends string> = {
  [Name in keyof BuiltInChatToolPolicyKindByName]: BuiltInChatToolPolicyKindByName[Name] extends K
    ? Name
    : never;
}[keyof BuiltInChatToolPolicyKindByName];
type PublicOfficialToolName = Extract<
  BuiltInApprovalToolName,
  ToolNameWithPolicyKind<"public_official">
>;
type ExternalInputToolName = Extract<
  BuiltInApprovalToolName,
  ToolNameWithPolicyKind<"external">
>;
const TOOL_CALL_STATE_IS_RUNNING = {
  "awaiting-input": true,
  "approval-requested": false,
  "approval-responded": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<ChatToolCallPart["state"], boolean>;
const isChatToolCallState = (
  value: string,
): value is ChatToolCallPart["state"] =>
  Object.hasOwn(TOOL_CALL_STATE_IS_RUNNING, value);
const USER_INPUT_TOOL_NAMES = {
  "ask-user": true,
} as const satisfies Record<string, true>;

// folio-agents tools a DOCX surface auto-runs against its bridge with no
// approval click: the read tools, plus the queue-only registration of
// `suggest_changes` (the bridge parks operations for per-suggestion review
// and never writes). The server-executed apply registration shares the name
// but is approval-gated, so its calls never rest in the `input-complete`
// state the watcher acts on once the stream is idle. The comment MUTATION
// tools (`add_comment`, `reply_comment`, `resolve_comment`) are deliberately
// NOT here: they carry `needsApproval` and are resolved through the approval
// flow, not this auto-run watcher.
const FOLIO_AGENT_DOC_TOOL_NAMES = {
  [FOLIO_AGENT_TOOL_NAMES.findText]: true,
  [FOLIO_AGENT_TOOL_NAMES.getDocumentOutline]: true,
  [FOLIO_AGENT_TOOL_NAMES.listStories]: true,
  [FOLIO_AGENT_TOOL_NAMES.readChanges]: true,
  [FOLIO_AGENT_TOOL_NAMES.readComments]: true,
  [FOLIO_AGENT_TOOL_NAMES.readDocument]: true,
  [FOLIO_AGENT_TOOL_NAMES.readSection]: true,
  [FOLIO_AGENT_TOOL_NAMES.readStory]: true,
  [FOLIO_AGENT_TOOL_NAMES.showInDocument]: true,
  [FOLIO_AGENT_TOOL_NAMES.suggestChanges]: true,
} as const satisfies Record<string, true>;

/** The one DOCX mutation tool: queued for review in manual mode, applied and saved by the API in auto mode. */
export const SUGGEST_CHANGES_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.suggestChanges;

type SuggestChangesOutput =
  ChatUITools[typeof SUGGEST_CHANGES_TOOL_NAME]["output"];

/**
 * The server-executed apply variant's outcome. The client-executed queue
 * variant answers with folio's `{ ok, ... }` envelope instead; the two
 * registrations share the tool name, so the output type is their union.
 */
export type SuggestChangesApplyOutput = Exclude<
  SuggestChangesOutput,
  { ok: boolean }
>;

// No shared discriminator exists across the two envelopes (`ok` vs
// `success`), so membership is decided by which one is present. Accepts
// `unknown` because TanStack types a two-registration tool's streamed
// output as unknown; the approval card passes the typed union.
export const isSuggestChangesApplyOutput = (
  output: unknown,
): output is SuggestChangesApplyOutput =>
  typeof output === "object" &&
  output !== null &&
  "success" in output &&
  typeof output.success === "boolean";

const CHAT_TOOL_TITLE_KEYS = {
  add_comment: "chat.tool.add_comment",
  "ask-user": "chat.tool.ask-user",
  boe_find_related_laws: "chat.tool.boe_find_related_laws",
  boe_get_law: "chat.tool.boe_get_law",
  boe_get_law_block: "chat.tool.boe_get_law_block",
  boe_get_law_structure: "chat.tool.boe_get_law_structure",
  boe_search_legislation: "chat.tool.boe_search_legislation",
  borme_get_summary: "chat.tool.borme_get_summary",
  business_registry_lookup: "chat.tool.business_registry_lookup",
  compare_versions: "chat.tool.compare_versions",
  review_folder_consistency: "chat.tool.review_folder_consistency",
  "create-document": "chat.tool.create-document",
  create_matter_document: "chat.tool.create_matter_document",
  "create-current-skill-resource": "common.edit",
  delete_clause: "chat.tool.delete_clause",
  delete_contact: "chat.tool.delete_contact",
  delete_document: "chat.tool.delete_document",
  delete_matter: "chat.tool.delete_matter",
  delete_task: "chat.tool.delete_task",
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
  get_document_outline: "chat.tool.get_document_outline",
  infosoud_lookup_case: "chat.tool.infosoud_lookup_case",
  link_matter_contact: "chat.tool.link_matter_contact",
  list_stories: "chat.tool.list_stories",
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
  read_section: "chat.tool.read_section",
  read_story: "chat.tool.read_story",
  remember: "chat.tool.remember",
  reply_comment: "chat.tool.reply_comment",
  resolve_comment: "chat.tool.resolve_comment",
  "read-skill-resource": "chat.tool.read-skill-resource",
  "search-chat-history": "chat.tool.search-chat-history",
  show_in_document: "chat.tool.show_in_document",
  suggest_changes: "chat.tool.suggest_changes",
  "update-current-skill-body": "common.edit",
  "update-current-skill-resource": "common.edit",
  "update-entity-fields": "chat.tool.update-entity-fields",
  web_search: "chat.tool.web_search",
} as const satisfies Record<keyof ChatUITools, TranslationKey>;

// Tools that used to be registered but were replaced by the unified
// `business_registry_lookup` (or removed for other reasons). Keep
// title keys around so historical chat history still renders with a
// recognisable label rather than the generic "unknown" fallback.
const RETIRED_CHAT_TOOL_TITLE_KEYS = {
  // The manual DOCX edit tool that `suggest_changes` replaced; persisted
  // threads still carry its calls.
  "apply-active-docx-edits": "chat.tool.apply-active-docx-edits",
  // The automatic DOCX edit tool the server-executed `suggest_changes`
  // variant replaced; persisted threads still carry its calls.
  edit_workspace_document: "chat.tool.suggest_changes",
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
  ...RETIRED_CHAT_TOOL_TITLE_KEYS,
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

const CHAT_TOOL_GRANT_POLICY_KIND = {
  /** May be covered by a stored "allow in conversation" or "always allow" grant. */
  grantable: "grantable",
  /** May only be approved once or denied per call — never a persistent grant. */
  approveOnce: "approve-once",
  /**
   * May never be auto-approved by any mechanism, not just a stored grant —
   * stronger than `approveOnce` (see {@link isNonPersistentGrantChatToolName}).
   */
  neverAuto: "never-auto",
} as const;

type ChatToolGrantPolicy =
  (typeof CHAT_TOOL_GRANT_POLICY_KIND)[keyof typeof CHAT_TOOL_GRANT_POLICY_KIND];

/**
 * Grant policy for every built-in tool whose backend policy kind requires
 * approval, keyed off {@link ApprovalRequiredBuiltInChatToolName} — a TOTAL
 * record, not `Partial`, so a newly approval-gated backend tool must be
 * classified here before it typechecks rather than silently defaulting to
 * `grantable`. `delete_*` tools are also covered independently by
 * {@link isDestructiveChatToolName}; they are listed here too so this record
 * stays authoritative on its own.
 */
const CHAT_TOOL_GRANT_POLICY = {
  add_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_search_legislation: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "create-current-skill-resource": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  create_matter_document: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  delete_clause: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  delete_contact: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  delete_document: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  delete_matter: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  delete_task: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  delete_time_entry: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  fetch_url: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  fill_template: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  link_matter_contact: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  manage_organization: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  remember: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  reply_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  resolve_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  run_playbook: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_clause: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_contact: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_document: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_matter: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_task: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_template: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  save_time_entry: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  set_field_value: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  set_practice_jurisdictions: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  spawn_subagents: CHAT_TOOL_GRANT_POLICY_KIND.neverAuto,
  // Only the server-executed apply variant ever requests approval; it writes
  // a new document version, so each call is approved on its own.
  suggest_changes: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  "update-current-skill-body": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "update-current-skill-resource": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "update-entity-fields": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  web_search: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
} as const satisfies Record<
  Extract<BuiltInApprovalToolName, ApprovalRequiredBuiltInChatToolName>,
  ChatToolGrantPolicy
>;

const isChatToolWithGrantPolicy = (
  toolName: string,
): toolName is keyof typeof CHAT_TOOL_GRANT_POLICY =>
  Object.hasOwn(CHAT_TOOL_GRANT_POLICY, toolName);

const getChatToolGrantPolicy = (toolName: string): ChatToolGrantPolicy =>
  isChatToolWithGrantPolicy(toolName)
    ? CHAT_TOOL_GRANT_POLICY[toolName]
    : CHAT_TOOL_GRANT_POLICY_KIND.grantable;

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
  getChatToolGrantPolicy(toolName) !== CHAT_TOOL_GRANT_POLICY_KIND.grantable;

/**
 * Chat tools that may never be auto-approved by any mechanism — not just a
 * stored grant, but also the public-official and DOCX-batch auto-approve
 * paths in `hasAutomaticApproval`. Delegation (`spawn_subagents`) kicks off
 * a whole subagent write-loop per call, so unlike a single mutation it must
 * be reviewed every time.
 */
export const isNonPersistentGrantChatToolName = (toolName: string): boolean =>
  getChatToolGrantPolicy(toolName) === CHAT_TOOL_GRANT_POLICY_KIND.neverAuto;

/**
 * Chat tools whose approval card renders the shared registry-write summary
 * (readable key/value rows, refs shown as chat refs, long values truncated).
 * Covers the registry write projections plus `fill_template` (served by the
 * hand-written template tool). A TOTAL record over every approval-required
 * built-in tool, so a newly approval-gated tool must decide whether it
 * renders the write summary before it typechecks.
 */
const REGISTRY_WRITE_SUMMARY_TOOL_NAMES = {
  add_comment: false,
  boe_search_legislation: false,
  "create-current-skill-resource": false,
  create_matter_document: false,
  delete_clause: true,
  delete_contact: true,
  delete_document: true,
  delete_matter: true,
  delete_task: true,
  delete_time_entry: true,
  fetch_url: false,
  fill_template: true,
  link_matter_contact: true,
  manage_organization: true,
  remember: true,
  reply_comment: false,
  resolve_comment: false,
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
  spawn_subagents: false,
  suggest_changes: false,
  "update-current-skill-body": false,
  "update-current-skill-resource": false,
  "update-entity-fields": false,
  web_search: false,
} as const satisfies Record<
  Extract<BuiltInApprovalToolName, ApprovalRequiredBuiltInChatToolName>,
  boolean
>;

const isRegistryWriteSummaryEligibleToolName = (
  toolName: string,
): toolName is keyof typeof REGISTRY_WRITE_SUMMARY_TOOL_NAMES =>
  Object.hasOwn(REGISTRY_WRITE_SUMMARY_TOOL_NAMES, toolName);

export const isRegistryWriteSummaryToolName = (toolName: string): boolean =>
  isRegistryWriteSummaryEligibleToolName(toolName) &&
  REGISTRY_WRITE_SUMMARY_TOOL_NAMES[toolName];

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

  if (
    !isChatToolCallState(part.state) ||
    !TOOL_CALL_STATE_IS_RUNNING[part.state]
  ) {
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
 * An unresolved auto-run folio-agents tool-call part (a read tool or
 * `suggest_changes`), narrowed by {@link isUnresolvedFolioAgentDocToolCallPart}.
 */
export type UnresolvedFolioAgentDocToolCallPart =
  RegisteredFolioAgentToolCallPart<keyof typeof FOLIO_AGENT_DOC_TOOL_NAMES> & {
    state: "input-complete";
  };

/**
 * An auto-run folio-agents tool-call part (a read tool or `suggest_changes`)
 * whose input has fully streamed in but that has not yet been answered with
 * a result.
 *
 * These tools (from `@stll/folio-agents`) are client-executed and carry no
 * `needsApproval` gate, so nothing else resolves them — the DOCX surfaces'
 * auto-run watchers (`file-chat-overlay.tsx`, `template-studio-chat.tsx`)
 * use this predicate to find calls they still need to execute against
 * their bridge and answer via `addToolResult`.
 */
export const isUnresolvedFolioAgentDocToolCallPart = (
  part: unknown,
): part is UnresolvedFolioAgentDocToolCallPart => {
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    !("state" in part) ||
    !("input" in part) ||
    typeof part.type !== "string" ||
    typeof part.state !== "string" ||
    part.input === undefined
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

// Terminal state a dead running tool-call part is rewritten to at
// hydration. "error" is the SDK's own terminal state for a failed tool
// call: it clears `isRunningToolPart` and renders the card as interrupted
// rather than a perpetual spinner. It never round-trips to the server —
// only `messages.at(-1)` is sent on a send, and a sanitized assistant part
// is never that message.
const INTERRUPTED_TOOL_CALL_STATE = "error" as const;

export type RunningToolCallSanitization = "cancel" | "hydrate";

const toTerminalIfRunningToolPart = (
  part: ChatPart,
  mode: RunningToolCallSanitization,
): ChatPart => {
  if (part.type !== "tool-call" || !isRunningToolPart(part)) {
    return part;
  }
  // The draft compiler can deterministically resume this client-executed tool
  // after hydration. Preserve it so the session effect can return its result
  // instead of turning a recoverable draft into an interrupted tool call.
  if (
    mode === "hydrate" &&
    part.name === "create-document" &&
    part.state === "input-complete" &&
    isJsonObject(part.input) &&
    typeof part.input["source"] === "string" &&
    part.input["source"].trim() !== ""
  ) {
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
 *  - Explicit stop: TanStack AI's `stop()` aborts the live request but never
 *    rewrites message parts, so a tool part caught mid-input would keep the
 *    turn "generating" forever. The runtime's `stop` applies this right
 *    after aborting.
 *
 * `ask-user` and approval-flow parts are user-owned and excluded by
 * `isRunningToolPart`. A complete `create-document` input is resumable by the
 * client and remains live until the draft result is returned. Messages and
 * parts left unchanged are returned by reference so downstream memoization
 * stays stable.
 */
export const sanitizeRunningToolCalls = (
  messages: readonly PersistedChatMessage[],
  mode: RunningToolCallSanitization = "hydrate",
): PersistedChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = message.parts.map((part) =>
      toTerminalIfRunningToolPart(part, mode),
    );
    const partsChanged = parts.some(
      (part, index) => part !== message.parts[index],
    );
    return partsChanged ? { ...message, parts } : message;
  });

type ChatTurnInFlightOptions = {
  status: ChatClientState;
  messages: PersistedChatMessage[];
  /**
   * Set when the user explicitly stopped the turn. TanStack AI's
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
 * call (network drop, server restart) TanStack AI flips its status to
 * `"error"` but leaves the partial tool part in a running state; the
 * SDK never auto-continues after an error, so treating that tail as
 * in-flight would wedge the session as "generating" until reload.
 */
export const isChatTurnInFlight = ({
  status,
  messages,
  turnAbandoned = false,
}: ChatTurnInFlightOptions): boolean => {
  if (turnAbandoned) {
    return false;
  }

  switch (status) {
    case "submitted":
    case "streaming":
      return true;
    case "error":
      return false;
    case "ready":
      return hasRunningToolCallInLatestAssistantMessage({ messages });
    default:
      status satisfies never;
      return panic("Unhandled chat client state");
  }
};

export const isChatClientRequestActive = (status: ChatClientState): boolean => {
  switch (status) {
    case "submitted":
    case "streaming":
      return true;
    case "error":
    case "ready":
      return false;
    default:
      status satisfies never;
      return panic("Unhandled chat client state");
  }
};

type ServerChatTurnOutcome = NonNullable<
  NonNullable<ChatMessage["metadata"]>["turnOutcome"]
>;

export type ResolvedChatAssistantTurnOutcome =
  | ServerChatTurnOutcome
  | { type: "incomplete" }
  | { type: "legacy-completed" };

type ChatAssistantTurnMessage = Pick<ChatMessage, "metadata" | "role"> & {
  parts: readonly ChatPart[];
};

/**
 * Resolve the server-owned terminal state for follow-up and error UI policy.
 * Legacy assistant messages predate `turnOutcome`; only a non-empty legacy
 * message may stand in for a completed turn.
 */
export const resolveChatAssistantTurnOutcome = (
  message: ChatAssistantTurnMessage | null,
): ResolvedChatAssistantTurnOutcome => {
  if (message?.role !== "assistant") {
    return { type: "incomplete" };
  }

  const outcome = message.metadata?.turnOutcome;
  if (outcome === undefined) {
    return message.parts.length > 0
      ? { type: "legacy-completed" }
      : { type: "incomplete" };
  }

  switch (outcome.type) {
    case "awaiting-user":
    case "cancelled":
    case "completed":
    case "failed":
    case "interrupted":
      return outcome;
    default:
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
  }
};

export const getChatAssistantTurnError = (
  message: ChatAssistantTurnMessage | null,
): Error | undefined => {
  const outcome = resolveChatAssistantTurnOutcome(message);
  switch (outcome.type) {
    case "failed":
      return new Error(outcome.error);
    case "awaiting-user":
    case "cancelled":
    case "completed":
    case "incomplete":
    case "interrupted":
    case "legacy-completed":
      return undefined;
    default:
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
  }
};

export const isOpaquePersistedChatToolCallPart = (
  value: unknown,
): value is OpaquePersistedChatToolCallPart => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "tool-call" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("arguments" in value) ||
    typeof value.arguments !== "string" ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !isChatToolCallState(value.state)
  ) {
    return false;
  }
  return !isChatToolName(value.name) && !isExternalMcpToolName(value.name);
};

const isCanonicalBuiltInToolCall = (
  value: TanStackChatToolCallPart,
): value is BuiltInChatToolCallPart => {
  if (!isChatToolName(value.name)) {
    return false;
  }
  if (value.state === "awaiting-input" || value.state === "input-streaming") {
    return (
      !("input" in value) ||
      value.input === undefined ||
      isJsonObject(value.input)
    );
  }
  return "input" in value && isJsonObject(value.input);
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCanonicalChatUIMessage = (
  message: PersistedChatMessage,
): message is ChatUIMessage =>
  message.parts.every(
    (part) =>
      part.type !== "tool-call" ||
      isExternalMcpToolName(part.name) ||
      isOpaquePersistedChatToolCallPart(part) ||
      isCanonicalBuiltInToolCall(part),
  );

/**
 * Prove the runtime-to-UI contract without parsing tool arguments again.
 * Completed built-in calls must already carry their canonical parsed input;
 * only protocol-partial calls may omit it.
 */
export const projectCanonicalChatUIMessages = (
  messages: readonly PersistedChatMessage[],
): ChatUIMessage[] => {
  const projected: ChatUIMessage[] = [];
  for (const message of messages) {
    if (!isCanonicalChatUIMessage(message)) {
      return panic("Chat runtime produced a non-canonical tool call");
    }
    projected.push(message);
  }
  return projected;
};

export type DocumentDeletionToolCallEffects = {
  hasVersionDeletion: boolean;
  hasWholeDocumentDeletion: boolean;
};

export type DocumentDeletionMessage = {
  id: string;
  role: string;
  parts: readonly unknown[];
};

/** Consume successful document delete calls not yet handled by this session. */
export const consumeDocumentDeletionToolCalls = ({
  handledToolCallIds,
  messages,
}: {
  handledToolCallIds: Set<string>;
  messages: readonly DocumentDeletionMessage[];
}): DocumentDeletionToolCallEffects => {
  let hasVersionDeletion = false;
  let hasWholeDocumentDeletion = false;

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (
        !isJsonObject(part) ||
        part["type"] !== "tool-call" ||
        part["name"] !== "delete_document" ||
        part["state"] !== "complete" ||
        typeof part["id"] !== "string" ||
        !isJsonObject(part["input"]) ||
        !isJsonObject(part["output"]) ||
        part["output"]["deleted"] !== true ||
        handledToolCallIds.has(part["id"])
      ) {
        continue;
      }

      handledToolCallIds.add(part["id"]);
      if ("version_id" in part["input"]) {
        hasVersionDeletion = true;
      } else {
        hasWholeDocumentDeletion = true;
      }
    }
  }

  return { hasVersionDeletion, hasWholeDocumentDeletion };
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

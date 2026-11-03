import type { ApprovalRequiredBuiltInChatToolName } from "./chat-tool-policy";
import { MCP_CHAT_TOOL_GRANT_POLICIES } from "./mcp-chat-tool-policy.gen";

/**
 * Whether an approval-gated chat tool may be covered by a stored approval
 * grant. The API enforces this when it stores a grant and when it decides
 * which calls skip the approval prompt; the web app reads the same map to
 * decide which grant buttons to offer.
 */
export const CHAT_TOOL_GRANT_POLICY_KIND = {
  /** May be covered by an "allow in conversation" or "always allow" grant. */
  grantable: "grantable",
  /** Approved or denied per call; never covered by a stored grant. */
  approveOnce: "approve-once",
  /**
   * Never covered by a stored grant, like `approveOnce`. The one exception is
   * the opt-in page-read allowance for the client-executed `use-browser`
   * tool, which the user's own browser applies before running a command.
   */
  neverAuto: "never-auto",
} as const;

export type ChatToolGrantPolicy =
  (typeof CHAT_TOOL_GRANT_POLICY_KIND)[keyof typeof CHAT_TOOL_GRANT_POLICY_KIND];

type GeneratedMcpGrantToolName = keyof typeof MCP_CHAT_TOOL_GRANT_POLICIES;
type ManualGrantToolName = Exclude<
  ApprovalRequiredBuiltInChatToolName,
  GeneratedMcpGrantToolName
>;

/** Grant policy for approval-gated built-in tools that do not project from MCP. */
const MANUAL_CHAT_TOOL_GRANT_POLICY = {
  add_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_find_related_laws: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_get_law: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_get_law_block: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_get_law_structure: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  boe_search_legislation: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  borme_get_summary: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  business_registry_lookup: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  counterparty_check: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "create-current-skill-resource": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  create_matter_document: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  fetch_url: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  fill_template: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  infosoud_lookup_case: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  remember: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  reply_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  resolve_comment: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "search-all-past-chats": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  use_connector_secret: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  // Only the server-executed apply variant ever requests approval; it writes
  // a new document version, so each call is approved on its own.
  suggest_changes: CHAT_TOOL_GRANT_POLICY_KIND.approveOnce,
  "update-current-skill-body": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "update-current-skill-resource": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  "update-entity-fields": CHAT_TOOL_GRANT_POLICY_KIND.grantable,
  // Every browser command asks every time, except the opt-in page-read
  // allowance described on `neverAuto`.
  "use-browser": CHAT_TOOL_GRANT_POLICY_KIND.neverAuto,
  web_search: CHAT_TOOL_GRANT_POLICY_KIND.grantable,
} as const satisfies Record<ManualGrantToolName, ChatToolGrantPolicy>;

/**
 * Total grant policy over every approval-gated built-in tool: MCP-projected
 * writes come from the registry-generated map, the rest from the manual map.
 */
const CHAT_TOOL_GRANT_POLICY = {
  ...MANUAL_CHAT_TOOL_GRANT_POLICY,
  ...MCP_CHAT_TOOL_GRANT_POLICIES,
} as const satisfies Record<
  ApprovalRequiredBuiltInChatToolName,
  ChatToolGrantPolicy
>;

/** Name prefix of tools served by an installed external MCP connector. */
const EXTERNAL_MCP_TOOL_NAME_PREFIX = "mcp__";

/** Approval-gated built-in tools: exactly the names the grant policy covers. */
export const isApprovalGatedBuiltInChatTool = (
  toolName: string,
): toolName is ApprovalRequiredBuiltInChatToolName =>
  Object.hasOwn(CHAT_TOOL_GRANT_POLICY, toolName);

/**
 * Built-in tools follow their entry. External connector tools (the `mcp__`
 * namespace) are grantable, covered through their connector. Any other name
 * has no standing approval: it asks on every call.
 */
export const getChatToolGrantPolicy = (
  toolName: string,
): ChatToolGrantPolicy => {
  if (isApprovalGatedBuiltInChatTool(toolName)) {
    return CHAT_TOOL_GRANT_POLICY[toolName];
  }
  return toolName.startsWith(EXTERNAL_MCP_TOOL_NAME_PREFIX)
    ? CHAT_TOOL_GRANT_POLICY_KIND.grantable
    : CHAT_TOOL_GRANT_POLICY_KIND.approveOnce;
};

export const isGrantableChatTool = (toolName: string): boolean =>
  getChatToolGrantPolicy(toolName) === CHAT_TOOL_GRANT_POLICY_KIND.grantable;

/**
 * How long a stored grant applies: the one conversation it was given in, or
 * every conversation of the user in the organization.
 */
export const CHAT_TOOL_GRANT_SCOPES = ["conversation", "always"] as const;
export type ChatToolGrantScope = (typeof CHAT_TOOL_GRANT_SCOPES)[number];

/**
 * What a stored grant covers. An external MCP grant covers every tool of one
 * installed connector; the API resolves the connector from the tool name, so
 * a client never names the subject itself.
 */
export type ChatToolGrantSubject =
  | { type: "tool"; toolName: string }
  | { type: "mcp-connector"; connectorId: string };

export type ChatToolGrant = {
  id: string;
  scope: ChatToolGrantScope;
  subject: ChatToolGrantSubject;
};

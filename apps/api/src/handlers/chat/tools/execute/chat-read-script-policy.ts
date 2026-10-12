import type {
  ChatProjectableToolName,
  RegistryReadToolName,
  READ_TOOL_REF_FIELD_MAP,
} from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { ThirdPartyOutboundReadToolName } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";

type ChatProjectableReadToolName = ChatProjectableToolName<
  typeof READ_TOOL_REF_FIELD_MAP
>;

const CHAT_READ_SCRIPT_POLICIES = ["script", "direct-only"] as const;

type ChatReadScriptPolicy = (typeof CHAT_READ_SCRIPT_POLICIES)[number];

/**
 * A script runs without outbound approval and holds no third-party outbound
 * permit, so a read whose handler needs one is `direct-only`: the policy map
 * fails to compile when it marks one `script`.
 */
type ChatReadScriptPolicyMap = Record<
  Exclude<ChatProjectableReadToolName, ThirdPartyOutboundReadToolName>,
  ChatReadScriptPolicy
> &
  Record<
    Extract<ChatProjectableReadToolName, ThirdPartyOutboundReadToolName>,
    "direct-only"
  >;

/**
 * How each chat-projectable read is offered. `script` reads are script
 * functions inside `execute_typescript`; `direct-only` reads are offered only
 * as their direct tool. The map is total, so every projectable read declares
 * one.
 */
export const CHAT_READ_SCRIPT_POLICY = {
  list_matters: "script",
  list_contacts: "script",
  search_across_matters: "script",
  read_content_across_matters: "script",
  read_contact: "script",
  list_documents: "script",
  read_document: "script",
  list_properties: "script",
  list_tasks: "script",
  list_clauses: "script",
  list_playbooks: "script",
  list_reader_annotations: "script",
  list_time_entries: "script",
  list_invoices: "script",
  list_templates: "script",
  get_usage: "script",
  search_case_law: "script",
  case_law_coverage: "script",
  read_case_law_decision: "script",
  read_case_law_citations: "script",
  search_legislation: "script",
  read_statute: "script",
  read_statute_provisions: "script",
  read_provision_history: "script",
  search_boe_legislation: "direct-only",
  lookup_business_registry: "direct-only",
} as const satisfies ChatReadScriptPolicyMap;

type DirectOnlyChatReadToolName = {
  [
    TName in keyof typeof CHAT_READ_SCRIPT_POLICY
  ]: (typeof CHAT_READ_SCRIPT_POLICY)[TName] extends "direct-only"
    ? TName
    : never;
}[keyof typeof CHAT_READ_SCRIPT_POLICY];

/**
 * The direct tool that offers each `direct-only` read in chat. A skill that
 * requires the read is available wherever that tool is offered.
 */
export const DIRECT_ONLY_CHAT_READ_TOOLS = {
  search_boe_legislation: "boe_search_legislation",
  lookup_business_registry: "business_registry_lookup",
} as const satisfies Record<DirectOnlyChatReadToolName, string>;

const CHAT_READ_SCRIPT_POLICY_BY_NAME: Readonly<
  Record<string, ChatReadScriptPolicy | undefined>
> = CHAT_READ_SCRIPT_POLICY;

/** Whether a read is offered as a script function in chat scripts. */
export const isChatScriptRead = (toolName: RegistryReadToolName): boolean =>
  CHAT_READ_SCRIPT_POLICY_BY_NAME[toolName] === "script";

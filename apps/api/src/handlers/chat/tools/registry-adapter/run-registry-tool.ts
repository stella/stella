import { panic, Result } from "better-result";

import { projectForChat } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolErrorKind } from "@/api/lib/errors/tagged-errors";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { CAPABILITY_TOOL_HANDLERS } from "@/api/mcp/capability-tools";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { DOCUMENT_TOOL_HANDLERS } from "@/api/mcp/document-tools";
import { finalizeToolEgress } from "@/api/mcp/egress";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import { KNOWLEDGE_TOOL_HANDLERS } from "@/api/mcp/knowledge-tools";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_HANDLERS } from "@/api/mcp/template-tools";
import type { InternalToolError, McpToolHandler } from "@/api/mcp/tool-types";

import type { RegistryReadToolName } from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateInputRefs } from "./ref-mediation";

/**
 * The read-only registry handlers chat may drive, gathered from the per-domain
 * exports and keyed by `RegistryReadToolName` via `satisfies`. Exhaustive by
 * construction (a second class-guard beside the ref-field map): a read tool with
 * no handler wired here cannot compile.
 */
const REGISTRY_READ_TOOL_HANDLERS = {
  fetch: COMPAT_TOOL_HANDLERS.fetch,
  search: COMPAT_TOOL_HANDLERS.search,
  list_matters: STELLA_TOOL_HANDLERS.list_matters,
  list_contacts: MATTER_TOOL_HANDLERS.list_contacts,
  read_case_law_decision: STELLA_TOOL_HANDLERS.read_case_law_decision,
  read_contact: STELLA_TOOL_HANDLERS.read_contact,
  read_content_across_matters: STELLA_TOOL_HANDLERS.read_content_across_matters,
  search_case_law: STELLA_TOOL_HANDLERS.search_case_law,
  search_across_matters: STELLA_TOOL_HANDLERS.search_across_matters,
  list_templates: TEMPLATE_TOOL_HANDLERS.list_templates,
  list_documents: DOCUMENT_TOOL_HANDLERS.list_documents,
  read_document: DOCUMENT_TOOL_HANDLERS.read_document,
  list_properties: DOCUMENT_TOOL_HANDLERS.list_properties,
  list_tasks: MATTER_TOOL_HANDLERS.list_tasks,
  lookup_business_registry: MATTER_TOOL_HANDLERS.lookup_business_registry,
  list_clauses: KNOWLEDGE_TOOL_HANDLERS.list_clauses,
  list_playbooks: KNOWLEDGE_TOOL_HANDLERS.list_playbooks,
  list_time_entries: BILLING_TOOL_HANDLERS.list_time_entries,
  resolve_rate: BILLING_TOOL_HANDLERS.resolve_rate,
  list_invoices: BILLING_TOOL_HANDLERS.list_invoices,
  get_usage: BILLING_TOOL_HANDLERS.get_usage,
  search_legislation: RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation,
  list_audit_log: RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log,
  // Non-projectable (`chatProjectable: false`): the capability meta-tools are
  // reached over MCP/CLI, never from chat, and the orchestrator refuses them
  // before dispatch. Wired only to keep this map exhaustive over every read
  // tool.
  list_capabilities: CAPABILITY_TOOL_HANDLERS.list_capabilities,
  describe_capability: CAPABILITY_TOOL_HANDLERS.describe_capability,
} satisfies Record<RegistryReadToolName, McpToolHandler>;

const MCP_CODE_TO_CHAT_KIND = {
  validation_error: "invalid-input",
  missing_scope: "unavailable",
  feature_disabled: "unavailable",
  not_found: "not-found",
  confirmation_required: "invalid-input",
  permission_denied: "unavailable",
  usage_limited: "limit",
  // A 409 needs a different action (refetch state, rename, regenerate), which
  // is the model correcting its input, not a defect or a bare retry.
  conflict: "invalid-input",
  rate_limited: "transient",
  upstream_unavailable: "transient",
  unknown_tool: "unavailable",
  internal_error: "server-defect",
} as const satisfies Record<McpErrorCode, ChatToolErrorKind>;

/**
 * Classify a typed registry error directly. Legacy code-less plain-text errors
 * default to `invalid-input`: the conservative non-blocking kind, since a
 * wrong `server-defect` would suppress legitimate corrected retries.
 */
export const classifyRegistryErrorKind = (
  error: InternalToolError,
): ChatToolErrorKind =>
  error.type === "structured"
    ? MCP_CODE_TO_CHAT_KIND[error.code]
    : "invalid-input";

export type RunRegistryReadToolProps = {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  context: McpRequestContext;
  refRegistry: ChatRefRegistry;
};

/**
 * Run one read-only MCP registry tool as a chat tool.
 *
 * 1. Refuse a tool the ref-field map keeps off the chat surface, or one whose
 *    deploy feature flag is off (feature gating still applies to chat; OAuth
 *    scope gating does not, see `buildMcpContextFromChat`).
 * 2. Dehydrate ref args to real UUIDs.
 * 3. Run the handler and finalize its egress in DEFAULT mode (chat is not the
 *    anonymized surface).
 * 4. Map an `isError` result into a `ChatToolError`; otherwise parse the JSON
 *    payload and project it for chat in a single schema-driven pass
 *    (`projectForChat`: strict parse, strip, ref hydration, UUID invariant).
 */
export const runRegistryReadTool = async ({
  toolName,
  args,
  context,
  refRegistry,
}: RunRegistryReadToolProps): Promise<Result<unknown, ChatToolError>> => {
  const entry = READ_TOOL_REF_FIELD_MAP[toolName];
  if (!entry.chatProjectable) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }

  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (!isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "This feature is not enabled on this deployment.",
      }),
    );
  }

  const dehydrated = dehydrateInputRefs({ args, refRegistry, toolName });
  if (Result.isError(dehydrated)) {
    return Result.err(dehydrated.error);
  }

  const response = await REGISTRY_READ_TOOL_HANDLERS[toolName]({
    args: dehydrated.value.args,
    context,
  });
  const finished = await finalizeToolEgress({
    context,
    mode: "default",
    response,
  });

  if (finished.status === "error") {
    return Result.err(
      new ChatToolError({
        kind: classifyRegistryErrorKind(finished.error),
        message: finished.error.message,
      }),
    );
  }

  // One schema-driven pass: strict parse (an unknown key — a field nobody
  // classified — fails closed before it can reach the model), then strip,
  // ref hydration, and the fail-closed "no tenant UUID reaches the model"
  // invariant in the same walk. Failures carry only paths to telemetry.
  return projectForChat({
    dehydration: dehydrated.value,
    payload: finished.data,
    refRegistry,
    schema: entry.projection,
    source: "run-registry-tool",
    toolName,
  });
};

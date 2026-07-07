import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { captureError } from "@/api/lib/analytics";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { DOCUMENT_TOOL_HANDLERS } from "@/api/mcp/document-tools";
import { finalizeMcpEgress } from "@/api/mcp/egress";
import { FEEDBACK_TOOL_HANDLERS } from "@/api/mcp/feedback-tools";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import {
  getGatewayMcpToolDefinition,
  isMcpToolFeatureEnabled,
  listGatewayMcpToolDefinitions,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { KNOWLEDGE_TOOL_HANDLERS } from "@/api/mcp/knowledge-tools";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_HANDLERS } from "@/api/mcp/template-tools";
import type {
  McpToolDefinition,
  McpToolHandler,
  ToolScope,
} from "@/api/mcp/tool-types";
import {
  MCP_INTERNAL_ERROR_HINT,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

const MCP_TOOL_HANDLERS = new Map<string, McpToolHandler>([
  ["fetch", COMPAT_TOOL_HANDLERS.fetch],
  ["search", COMPAT_TOOL_HANDLERS.search],
  ["list_matters", STELLA_TOOL_HANDLERS.list_matters],
  ["read_case_law_decision", STELLA_TOOL_HANDLERS.read_case_law_decision],
  ["read_contact", STELLA_TOOL_HANDLERS.read_contact],
  [
    "read_content_across_matters",
    STELLA_TOOL_HANDLERS.read_content_across_matters,
  ],
  ["search_case_law", STELLA_TOOL_HANDLERS.search_case_law],
  ["search_across_matters", STELLA_TOOL_HANDLERS.search_across_matters],
  [
    "set_practice_jurisdictions",
    STELLA_TOOL_HANDLERS.set_practice_jurisdictions,
  ],
  ["list_templates", TEMPLATE_TOOL_HANDLERS.list_templates],
  ["fill_template", TEMPLATE_TOOL_HANDLERS.fill_template],
  ["save_template", TEMPLATE_TOOL_HANDLERS.save_template],
  ["list_documents", DOCUMENT_TOOL_HANDLERS.list_documents],
  ["read_document", DOCUMENT_TOOL_HANDLERS.read_document],
  ["save_document", DOCUMENT_TOOL_HANDLERS.save_document],
  ["delete_document", DOCUMENT_TOOL_HANDLERS.delete_document],
  ["list_properties", DOCUMENT_TOOL_HANDLERS.list_properties],
  ["set_field_value", DOCUMENT_TOOL_HANDLERS.set_field_value],
  ["save_matter", MATTER_TOOL_HANDLERS.save_matter],
  ["delete_matter", MATTER_TOOL_HANDLERS.delete_matter],
  ["save_contact", MATTER_TOOL_HANDLERS.save_contact],
  ["delete_contact", MATTER_TOOL_HANDLERS.delete_contact],
  ["lookup_business_registry", MATTER_TOOL_HANDLERS.lookup_business_registry],
  ["list_tasks", MATTER_TOOL_HANDLERS.list_tasks],
  ["save_task", MATTER_TOOL_HANDLERS.save_task],
  ["link_matter_contact", MATTER_TOOL_HANDLERS.link_matter_contact],
  ["list_clauses", KNOWLEDGE_TOOL_HANDLERS.list_clauses],
  ["save_clause", KNOWLEDGE_TOOL_HANDLERS.save_clause],
  ["delete_clause", KNOWLEDGE_TOOL_HANDLERS.delete_clause],
  ["list_playbooks", KNOWLEDGE_TOOL_HANDLERS.list_playbooks],
  ["run_playbook", KNOWLEDGE_TOOL_HANDLERS.run_playbook],
  ["list_time_entries", BILLING_TOOL_HANDLERS.list_time_entries],
  ["save_time_entry", BILLING_TOOL_HANDLERS.save_time_entry],
  ["delete_time_entry", BILLING_TOOL_HANDLERS.delete_time_entry],
  ["resolve_rate", BILLING_TOOL_HANDLERS.resolve_rate],
  ["list_invoices", BILLING_TOOL_HANDLERS.list_invoices],
  ["get_usage", BILLING_TOOL_HANDLERS.get_usage],
  ["search_legislation", RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation],
  ["list_audit_log", RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log],
  ["manage_organization", RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization],
  ["send_feedback", FEEDBACK_TOOL_HANDLERS.send_feedback],
]);

export const getMcpToolDefinition = async (
  toolName: string,
  context: McpRequestContext,
  mode: McpMode = "default",
): Promise<McpToolDefinition | undefined> =>
  await getGatewayMcpToolDefinition({ context, mode, toolName });

export const getMcpToolScopeHint = (
  toolName: string,
  mode: McpMode = "default",
): ToolScope | undefined => {
  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (staticTool) {
    return staticTool.scope;
  }

  if (mode === "anonymized") {
    return undefined;
  }

  if (isExternalMcpToolName(toolName)) {
    return "stella:external_mcps";
  }

  if (isSkillToolName(toolName)) {
    return "stella:skills";
  }

  return undefined;
};

export const listMcpTools = async (
  context: McpRequestContext,
  mode: McpMode = "default",
  scopes?: readonly string[],
): Promise<McpTool[]> => {
  if (scopes === undefined) {
    return toMcpTools(await listGatewayMcpToolDefinitions({ context, mode }));
  }

  return toMcpTools(
    await listGatewayMcpToolDefinitions({ context, mode, scopes }),
  );
};

export const handleMcpToolCall = async ({
  args,
  context,
  mode = "default",
  toolName,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode?: McpMode;
  toolName: string;
}): Promise<CallToolResult> => {
  const gatewayResult = await dispatchGatewayToolCall({
    args,
    context,
    mode,
    toolName,
  });
  if (gatewayResult) {
    return gatewayResult;
  }

  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (!staticTool) {
    return structuredErrorResult({
      code: "unknown_tool",
      message: `Unknown tool: ${toolName}`,
      hint: "Call tools/list for the tools available to this session.",
    });
  }

  // Reject a gated-off tool even when the caller names it directly: the list
  // surface hides it, and this closes the guess-the-name bypass so the gate
  // holds on both the advertisement and the dispatch path.
  if (!isMcpToolFeatureEnabled(staticTool.feature)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "This feature is not enabled on this deployment",
      hint: "This deployment or organization has this feature turned off; it cannot be enabled from the client.",
    });
  }

  // Destructive-op guardrail (agent misuse protection): an irreversible tool
  // (delete_*) must be called with `confirm: true`, set only after a human user
  // approved the action. Runs before dispatch so the mutation never starts
  // without the confirmation.
  if (
    staticTool.annotations?.destructiveHint === true &&
    args["confirm"] !== true
  ) {
    return structuredErrorResult({
      code: "confirmation_required",
      message: `${toolName} is an irreversible operation and was called without confirmation`,
      hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
    });
  }

  const handler = MCP_TOOL_HANDLERS.get(toolName);
  if (!handler) {
    return structuredErrorResult({
      code: "unknown_tool",
      message: `Unknown tool: ${toolName}`,
      hint: "Call tools/list for the tools available to this session.",
    });
  }

  try {
    // Handlers never see the mode: they return either a finished result or an
    // egress plan. The central pipeline applies anonymization (anonymized mode)
    // before windowing, then serializes. Both steps run inside this try so an
    // anonymization or windowing failure is captured like any handler failure.
    const response = await handler({ args, context });
    return await finalizeMcpEgress({ context, mode, response });
  } catch (error) {
    captureError(error, { source: "mcp", toolName });
    // Generic message: never leak internals to the caller. `captureError` keeps
    // the real exception for observability.
    return structuredErrorResult({
      code: "internal_error",
      message: "Tool execution failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
};

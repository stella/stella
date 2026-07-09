import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { captureError } from "@/api/lib/analytics";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { finalizeMcpEgress } from "@/api/mcp/egress";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import {
  getGatewayMcpToolDefinition,
  isMcpToolFeatureEnabled,
  listGatewayMcpToolDefinitions,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import {
  DEFAULT_MCP_TOOL_SETS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import type {
  McpToolDefinition,
  McpToolHandler,
  ToolScope,
} from "@/api/mcp/tool-types";
import {
  MCP_INTERNAL_ERROR_HINT,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

const MCP_TOOL_HANDLERS = new Map<string, McpToolHandler>(
  DEFAULT_MCP_TOOL_SETS.flatMap((toolSet) => Object.entries(toolSet.handlers)),
);

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

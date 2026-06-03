import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { captureError } from "@/api/lib/analytics";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import {
  getGatewayMcpToolDefinition,
  listGatewayMcpToolDefinitions,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import type {
  McpToolDefinition,
  McpToolHandler,
  ToolScope,
} from "@/api/mcp/tool-types";
import { errorResult } from "@/api/mcp/tool-utils";

const MCP_TOOL_HANDLERS = new Map<string, McpToolHandler>([
  ["fetch", COMPAT_TOOL_HANDLERS.fetch],
  ["search", COMPAT_TOOL_HANDLERS.search],
  ["get_matter_overview", STELLA_TOOL_HANDLERS.get_matter_overview],
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

  if (!getStaticMcpToolDefinition(toolName, mode)) {
    return errorResult(`Unknown tool: ${toolName}`);
  }

  const handler = MCP_TOOL_HANDLERS.get(toolName);
  if (!handler) {
    return errorResult(`Unknown tool: ${toolName}`);
  }

  try {
    return await handler({
      args,
      context,
      mode,
    });
  } catch (error) {
    captureError(error, { source: "mcp", toolName });
    return errorResult("Tool execution failed");
  }
};

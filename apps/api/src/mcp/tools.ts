import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { captureError } from "@/api/lib/analytics";
import { unreachable } from "@/api/lib/errors/tagged-errors";
import {
  ANONYMIZED_COMPAT_TOOL_DEFINITIONS,
  COMPAT_TOOL_DEFINITIONS,
  COMPAT_TOOL_HANDLERS,
} from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  STELLA_TOOL_DEFINITIONS,
  STELLA_TOOL_HANDLERS,
} from "@/api/mcp/stella-tools";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import { errorResult } from "@/api/mcp/tool-utils";

const DEFAULT_TOOL_DEFINITIONS = [
  ...COMPAT_TOOL_DEFINITIONS,
  ...STELLA_TOOL_DEFINITIONS,
] satisfies McpToolDefinition[];

const toAnonymizedToolDefinition = (
  tool: McpToolDefinition,
): McpToolDefinition | null => {
  switch (tool.name) {
    case "read_case_law_decision": {
      if (tool.scope !== "stella:read") {
        return unreachable(
          `read_case_law_decision must use stella:read, got ${tool.scope}`,
        );
      }

      return {
        ...tool,
        scope: "stella:read_anonymized",
      };
    }

    case "search_case_law": {
      if (tool.scope !== "stella:search") {
        return unreachable(
          `search_case_law must use stella:search, got ${tool.scope}`,
        );
      }

      return {
        ...tool,
        scope: "stella:search_anonymized",
      };
    }

    default:
      return null;
  }
};

const ANONYMIZED_STELLA_TOOL_DEFINITIONS = STELLA_TOOL_DEFINITIONS.flatMap(
  (tool) => {
    const anonymized = toAnonymizedToolDefinition(tool);
    return anonymized === null ? [] : [anonymized];
  },
) satisfies McpToolDefinition[];

const ANONYMIZED_TOOL_DEFINITIONS = [
  ...ANONYMIZED_COMPAT_TOOL_DEFINITIONS,
  ...ANONYMIZED_STELLA_TOOL_DEFINITIONS,
] satisfies McpToolDefinition[];

const MCP_TOOL_DEFINITION_MAPS = {
  default: new Map(DEFAULT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool])),
  anonymized: new Map(
    ANONYMIZED_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
} satisfies Record<McpMode, Map<string, McpToolDefinition>>;

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
]);

export const getMcpToolDefinition = (
  toolName: string,
  mode: McpMode = "default",
) => MCP_TOOL_DEFINITION_MAPS[mode].get(toolName);

export const listMcpTools = (mode: McpMode = "default"): McpTool[] =>
  (mode === "default"
    ? DEFAULT_TOOL_DEFINITIONS
    : ANONYMIZED_TOOL_DEFINITIONS
  ).map(({ annotations, description, inputSchema, name }) => ({
    ...(annotations === undefined ? {} : { annotations }),
    description,
    inputSchema,
    name,
  }));

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
  if (!getMcpToolDefinition(toolName, mode)) {
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

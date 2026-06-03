import { unreachable } from "@/api/lib/errors/tagged-errors";
import {
  ANONYMIZED_COMPAT_TOOL_DEFINITIONS,
  COMPAT_TOOL_DEFINITIONS,
} from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import { STELLA_TOOL_DEFINITIONS } from "@/api/mcp/stella-tools";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

const DEFAULT_TOOL_DEFINITIONS = [
  ...COMPAT_TOOL_DEFINITIONS,
  ...STELLA_TOOL_DEFINITIONS,
] as const satisfies readonly McpToolDefinition[];

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
) satisfies readonly McpToolDefinition[];

const ANONYMIZED_TOOL_DEFINITIONS = [
  ...ANONYMIZED_COMPAT_TOOL_DEFINITIONS,
  ...ANONYMIZED_STELLA_TOOL_DEFINITIONS,
] as const satisfies readonly McpToolDefinition[];

const MCP_TOOL_DEFINITION_MAPS = {
  default: new Map<string, McpToolDefinition>(
    DEFAULT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
  anonymized: new Map<string, McpToolDefinition>(
    ANONYMIZED_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
} satisfies Record<McpMode, Map<string, McpToolDefinition>>;

export const getStaticMcpToolDefinition = (
  toolName: string,
  mode: McpMode = "default",
) => MCP_TOOL_DEFINITION_MAPS[mode].get(toolName);

export const listStaticMcpToolDefinitions = (
  mode: McpMode = "default",
): readonly McpToolDefinition[] =>
  mode === "default" ? DEFAULT_TOOL_DEFINITIONS : ANONYMIZED_TOOL_DEFINITIONS;

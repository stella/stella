import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";

export type JsonSchema = McpTool["inputSchema"];

export type ToolScope =
  | "stella:read"
  | "stella:search"
  | "stella:read_anonymized"
  | "stella:search_anonymized";

export type McpToolDefinition = {
  annotations?: McpTool["annotations"];
  description: string;
  inputSchema: JsonSchema;
  name: string;
  scope: ToolScope;
};

export type McpToolHandler = ({
  args,
  context,
  mode,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode: McpMode;
}) => Promise<CallToolResult>;

import type { CallToolResult } from "@modelcontextprotocol/server";

export type McpToolCallOutcome = "ok" | "tool_error" | "internal_error";

// Server-owned provenance survives result spreads but never JSON serialization.
// Upstream content, including an error named internal_error, cannot set it.
export const MCP_INTERNAL_TOOL_FAILURE = Symbol("mcp.internal-tool-failure");

export const getMcpToolCallOutcome = (
  result: CallToolResult,
): McpToolCallOutcome => {
  if (
    MCP_INTERNAL_TOOL_FAILURE in result &&
    result[MCP_INTERNAL_TOOL_FAILURE] === true
  ) {
    return "internal_error";
  }
  return result.isError === true ? "tool_error" : "ok";
};

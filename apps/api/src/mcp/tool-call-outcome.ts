import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";

import { isRecord } from "@/api/lib/type-guards";
import { isMcpErrorCode, type McpErrorCode } from "@/api/mcp/error-codes";

export type McpToolCallOutcome = "ok" | "tool_error" | "internal_error";

export type McpToolCallAnalyticsOutcome =
  | { outcome: "ok" | "tool_error" }
  | { outcome: "refused"; errorCode: McpErrorCode | "unknown" }
  | { outcome: "internal_error" };

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

const typedEnvelopeCode = (result: CallToolResult): unknown => {
  if (result.isError !== true || result.content.length !== 1) {
    return undefined;
  }
  const content = result.content.at(0);
  if (content?.type !== "text") {
    return undefined;
  }
  const decoded = Result.try((): unknown => JSON.parse(content.text));
  if (decoded.isErr()) {
    return undefined;
  }
  const parsed = decoded.value;
  if (!isRecord(parsed) || !isRecord(parsed["error"])) {
    return undefined;
  }
  const error = parsed["error"];
  return typeof error["code"] === "string" &&
    typeof error["message"] === "string"
    ? error["code"]
    : undefined;
};

export const getMcpToolCallAnalyticsOutcome = (
  result: CallToolResult,
): McpToolCallAnalyticsOutcome => {
  if (
    MCP_INTERNAL_TOOL_FAILURE in result &&
    result[MCP_INTERNAL_TOOL_FAILURE] === true
  ) {
    return { outcome: "internal_error" };
  }
  const errorCode = typedEnvelopeCode(result);
  if (errorCode !== undefined) {
    return {
      outcome: "refused",
      errorCode: isMcpErrorCode(errorCode) ? errorCode : "unknown",
    };
  }
  return { outcome: result.isError === true ? "tool_error" : "ok" };
};

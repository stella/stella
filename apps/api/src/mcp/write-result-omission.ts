import type { CallToolResult } from "@modelcontextprotocol/server";

import type { McpToolAccess, McpToolOutputSchema } from "@/api/mcp/tool-types";

/**
 * The structured result a write tool answers with when the action ran but its
 * result exceeds the configured response byte limit: the action is applied,
 * the result is left out, and the caller inspects the outcome with a read tool
 * instead of repeating the action.
 */
export const MCP_OMITTED_WRITE_RESULT = {
  applied: true,
  resultOmitted: true,
  reason: "result_too_large",
} as const;

const OMITTED_WRITE_RESULT_KEYS = Object.keys(MCP_OMITTED_WRITE_RESULT);

/** Each omission field, pinned to the one value the transport sends. */
const OMITTED_WRITE_RESULT_PROPERTIES = Object.fromEntries(
  Object.entries(MCP_OMITTED_WRITE_RESULT).map(([key, value]) => [
    key,
    { type: typeof value === "boolean" ? "boolean" : "string", enum: [value] },
  ]),
);

/** The `tools/call` result carrying {@link MCP_OMITTED_WRITE_RESULT}. */
export const omittedWriteToolResult = (): CallToolResult => ({
  isError: false,
  content: [
    {
      type: "text",
      text: "Action applied. The result was too large and was omitted. Do not repeat the action; use a read tool to inspect its outcome.",
    },
  ],
  structuredContent: { ...MCP_OMITTED_WRITE_RESULT },
});

/** The omitted result as one closed object schema. */
const OMITTED_WRITE_RESULT_SCHEMA = {
  type: "object",
  properties: OMITTED_WRITE_RESULT_PROPERTIES,
  required: OMITTED_WRITE_RESULT_KEYS,
  additionalProperties: false,
};

/**
 * The advertised output schema of a write tool accepts the omitted result
 * beside the tool's own output: an object root whose two `anyOf` branches are
 * the tool's own closed schema, unchanged, and the closed omission schema.
 * The root keeps `type: "object"`, which the 2025-era wire requires of an
 * output schema root, and each branch is a complete object schema, so a
 * strict validator compiles it and neither contract is loosened: the tool's
 * required fields stay required, and the omission marker is accepted only
 * whole and with its pinned values.
 */
export const withWriteResultOmission = (
  schema: McpToolOutputSchema,
): McpToolOutputSchema => ({
  type: "object",
  anyOf: [schema, OMITTED_WRITE_RESULT_SCHEMA],
});

/**
 * The schema a tool advertises for its result: a write tool's own output or
 * its omitted result, a read tool's own output. Reads over the byte limit are
 * refused with an error instead, so they carry no omission marker.
 */
export const advertisedMcpOutputSchema = (
  schema: McpToolOutputSchema,
  access: McpToolAccess,
): McpToolOutputSchema =>
  access === "write" ? withWriteResultOmission(schema) : schema;

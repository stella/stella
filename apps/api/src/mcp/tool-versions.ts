import type { Tool } from "@modelcontextprotocol/server";

import { sha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";
import type { StableStringifyInput } from "@stll/stable-stringify";

export const MCP_TOOL_SCHEMA_VERSION_META_KEY = "schemaVersion";

const versionedShape = (tool: Tool) => ({
  annotations: tool.annotations,
  description: tool.description,
  inputSchema: tool.inputSchema,
  name: tool.name,
  outputSchema: tool.outputSchema,
  title: tool.title,
});

const canonicalInput = (value: unknown): StableStringifyInput => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "symbol"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalInput);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, canonicalInput(child)]),
    );
  }
  if (typeof value === "function") {
    return undefined;
  }
  return undefined;
};

/** Stable content identity of the fields that tell a client how to use a tool. */
export const mcpToolSchemaVersion = (tool: Tool): string =>
  sha256Hex(stableStringify(canonicalInput(versionedShape(tool))));

export const withMcpToolSchemaVersion = (tool: Tool): Tool => ({
  ...tool,
  _meta: {
    ...tool._meta,
    [MCP_TOOL_SCHEMA_VERSION_META_KEY]: mcpToolSchemaVersion(tool),
  },
});

/** ETag-like identity of exactly the ordered projection returned by tools/list. */
export const mcpRegistryVersion = (tools: readonly Tool[]): string =>
  sha256Hex(
    stableStringify(
      canonicalInput(
        tools.map((tool) => ({
          name: tool.name,
          version: mcpToolSchemaVersion(tool),
        })),
      ),
    ),
  );

import type { JSONSchema } from "@tanstack/ai";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

import type { McpToolInputSchema } from "@/api/mcp/tool-types";

/**
 * The MCP registry stores each tool's input as a plain JSON Schema object
 * (`McpTool["inputSchema"]`). code-mode's `toolDefinition` types `inputSchema`
 * as `SchemaInput`, whose plain-JSON-Schema branch is a nominally distinct
 * interface, so the two JSON-Schema *types* do not unify structurally even
 * though the value is a valid JSON Schema. Rebuilding the JSON value avoids an
 * assertion while removing Stella's server-only normalization annotation. The
 * annotation's generated guidance remains in `description`; execution reads
 * the canonical MCP schema directly. Shared by the read projection
 * (`chat-code-mode.ts`) and the write projection (`registry-write-tools.ts`) so
 * this stays the single conversion boundary.
 */
const copyJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => copyJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const copied: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === AGENT_INPUT_NORMALIZATION_KEY) {
        continue;
      }
      copied[key] = copyJsonValue(nested);
    }
    return copied;
  }
  return value;
};

export const toToolInputSchema = (
  schema: McpToolInputSchema,
  excludedTopLevelProperties?: readonly string[],
): JSONSchema => {
  const converted: JSONSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    converted[key] = copyJsonValue(value);
  }
  if (excludedTopLevelProperties === undefined) {
    return converted;
  }
  for (const property of excludedTopLevelProperties) {
    delete converted.properties?.[property];
    if (converted.required !== undefined) {
      converted.required = converted.required.filter(
        (required) => required !== property,
      );
    }
  }
  return converted;
};

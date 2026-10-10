import { describe, expect, test } from "bun:test";

import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

const OPERATION_SELECTOR_NAMES = new Set([
  "capability",
  "capability_id",
  "endpoint",
  "method",
  "operation",
  "operation_id",
]);

export const defaultSurfaceViolations = (
  definitions: readonly McpToolDefinition[],
): string[] => {
  const violations: string[] = [];
  for (const definition of definitions) {
    const propertyNames = Object.keys(definition.inputSchema.properties ?? {});
    if (propertyNames.some((name) => OPERATION_SELECTOR_NAMES.has(name))) {
      violations.push(`${definition.name}: operation selector`);
    }
    if (definition.name.startsWith("mcp__")) {
      violations.push(`${definition.name}: dynamic gateway`);
    }
    const { annotations } = definition;
    if (
      annotations.title.trim().length === 0 ||
      typeof annotations.readOnlyHint !== "boolean" ||
      typeof annotations.destructiveHint !== "boolean" ||
      typeof annotations.openWorldHint !== "boolean"
    ) {
      violations.push(`${definition.name}: incomplete annotations`);
    }
  }
  return violations;
};

describe("default MCP purpose-built tool guard", () => {
  test("allows no generic executor, gateway, or incomplete annotation", () => {
    expect(
      defaultSurfaceViolations(listStaticMcpToolDefinitions("default")),
    ).toEqual([]);
  });

  test("rejects an executor-shaped tool", () => {
    const [source] = listStaticMcpToolDefinitions("default");
    if (source === undefined) {
      throw new Error("default MCP registry must not be empty");
    }
    const fake = {
      ...source,
      inputSchema: {
        type: "object",
        properties: { operation_id: { type: "string" } },
      },
      name: "fake_executor",
    } satisfies McpToolDefinition;

    expect(defaultSurfaceViolations([fake])).toEqual([
      "fake_executor: operation selector",
    ]);
  });
});

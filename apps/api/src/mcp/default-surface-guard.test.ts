import { describe, expect, test } from "bun:test";

import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

const OPERATION_SELECTOR_NAMES = new Set([
  "capability",
  "capability_id",
  "endpoint",
  "endpoint_id",
  "id",
  "method",
  "operation",
  "operation_id",
]);

const PASSTHROUGH_INPUT_NAMES = new Set(["body", "input"]);
const LISTING_SELECTOR_DESCRIPTION = /(?:capability|operation|endpoint)\s+id/iu;
const PASSTHROUGH_SELECTOR_DESCRIPTION =
  /id\s+(?:from|returned by)\s+(?:a\s+)?(?:list|listing)/iu;
const GENERIC_OPERATION_LISTING =
  /list the (?:automatable )?capabilities beyond the curated tools/iu;

const schemaText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(schemaText).join(" ");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  return Object.values(value).map(schemaText).join(" ");
};

const hasOperationSelector = (definition: McpToolDefinition): boolean => {
  const properties = definition.inputSchema.properties ?? {};
  const propertyNames = Object.keys(properties);
  const hasPassthroughInput = propertyNames.some((name) =>
    PASSTHROUGH_INPUT_NAMES.has(name),
  );

  return (
    propertyNames.some((name) => {
      if (!OPERATION_SELECTOR_NAMES.has(name)) {
        const description = schemaText(properties[name]);
        return (
          LISTING_SELECTOR_DESCRIPTION.test(description) ||
          (hasPassthroughInput &&
            PASSTHROUGH_SELECTOR_DESCRIPTION.test(description))
        );
      }
      return name !== "id" || hasPassthroughInput;
    }) || GENERIC_OPERATION_LISTING.test(definition.description)
  );
};

export const defaultSurfaceViolations = (
  definitions: readonly McpToolDefinition[],
): string[] => {
  const violations: string[] = [];
  for (const definition of definitions) {
    if (hasOperationSelector(definition)) {
      violations.push(`${definition.name}: operation selector`);
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
  test("allows no generic executor or incomplete annotation", () => {
    expect(
      defaultSurfaceViolations(listStaticMcpToolDefinitions("default")),
    ).toEqual([]);
  });

  test("rejects every real advanced-only static definition", () => {
    const defaultNames = new Set(
      listStaticMcpToolDefinitions("default").map(({ name }) => name),
    );
    const advancedOnly = listStaticMcpToolDefinitions("advanced").filter(
      ({ name }) => !defaultNames.has(name),
    );

    expect(advancedOnly.map(({ name }) => name)).toEqual([
      "list_capabilities",
      "describe_capability",
      "read_capability",
      "write_capability",
    ]);
    expect(defaultSurfaceViolations(advancedOnly)).toEqual(
      advancedOnly.map(({ name }) => `${name}: operation selector`),
    );
  });
});

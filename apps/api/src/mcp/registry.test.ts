import { describe, expect, test } from "bun:test";

import { CAPABILITY_TOOL_SET } from "@/api/mcp/capability-tools";
import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import { DOCUMENT_TOOL_SET } from "@/api/mcp/document-tools";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  DOCUMENTS_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";

describe("MCP tool registry", () => {
  test("anonymizing tools declare at least one text field", () => {
    for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
      const { anonymized } = tool;
      if (anonymized.exposure === "anonymize") {
        expect(anonymized.textFields.length).toBeGreaterThan(0);
      }
    }
  });

  test("anonymized projection is exactly the registry minus excluded tools", () => {
    const expectedNames = DEFAULT_MCP_TOOL_DEFINITIONS.filter(
      (tool) => tool.anonymized.exposure !== "excluded",
    )
      .map((tool) => tool.name)
      .sort();

    const projectedNames = ANONYMIZED_MCP_TOOL_DEFINITIONS.map(
      (tool) => tool.name,
    ).sort();

    expect(projectedNames).toEqual(expectedNames);
  });

  test("projection preserves schema/annotations and only remaps scope and description", () => {
    const byName = new Map<string, McpToolDefinition>(
      DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
    );

    for (const projected of ANONYMIZED_MCP_TOOL_DEFINITIONS) {
      const source = byName.get(projected.name);
      if (!source) {
        throw new Error(`Projected tool ${projected.name} has no source`);
      }

      expect(projected.inputSchema).toEqual(source.inputSchema);
      expect(projected.annotations).toEqual(source.annotations);
      // Scope is always remapped to an anonymized scope.
      expect(projected.scope).not.toBe(source.scope);

      const expectedDescription =
        source.anonymized.exposure === "anonymize" &&
        source.anonymized.description !== undefined
          ? source.anonymized.description
          : source.description;
      expect(projected.description).toBe(expectedDescription);
    }
  });

  test("advertises exactly the scopes used by the anonymized projection", () => {
    const projectedScopes = [
      ...new Set(ANONYMIZED_MCP_TOOL_DEFINITIONS.map((tool) => tool.scope)),
    ].sort();

    expect(projectedScopes).toEqual([...MCP_ANONYMIZED_RESOURCE_SCOPES].sort());
  });

  test("every default tool scope is an advertised default scope", () => {
    const definitions: readonly McpToolDefinition[] =
      DEFAULT_MCP_TOOL_DEFINITIONS;
    const defaultScopes: readonly ToolScope[] = MCP_DEFAULT_RESOURCE_SCOPES;
    for (const tool of definitions) {
      expect(defaultScopes).toContain(tool.scope);
      if (tool.additionalScopes !== undefined) {
        for (const scope of tool.additionalScopes) {
          expect(defaultScopes).toContain(scope);
          expect(scope).not.toBe(tool.scope);
        }
      }
    }
  });

  test("documents projection contains document tools and only invoke capability", () => {
    const projectedNames = new Set(
      DOCUMENTS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    const capabilityNames = new Set(
      CAPABILITY_TOOL_SET.definitions.map((tool) => tool.name),
    );

    for (const tool of DOCUMENT_TOOL_SET.definitions) {
      expect(projectedNames).toContain(tool.name);
    }
    expect(projectedNames).toContain("invoke_capability");
    for (const toolName of capabilityNames) {
      if (toolName !== "invoke_capability") {
        expect(projectedNames).not.toContain(toolName);
      }
    }

    for (const toolName of projectedNames) {
      expect(
        DOCUMENT_TOOL_SET.definitions.some((tool) => tool.name === toolName) ||
          toolName === "invoke_capability",
      ).toBe(true);
    }
  });

  test("tool names are unique across the registry", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

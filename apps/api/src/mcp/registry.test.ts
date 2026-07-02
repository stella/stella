import { describe, expect, test } from "bun:test";

import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  MCP_ANONYMIZED_PROJECTED_SCOPES,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { MCP_ANONYMIZED_EXCLUSION_REASONS } from "@/api/mcp/tool-types";

describe("MCP tool registry", () => {
  test("every static tool declares a valid anonymized policy", () => {
    for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
      const { anonymized } = tool;
      if (anonymized.exposure === "anonymize") {
        // Declared egress-anonymized fields must be a non-empty, documented list.
        expect(anonymized.textFields.length).toBeGreaterThan(0);
        continue;
      }
      if (anonymized.exposure === "excluded") {
        expect(MCP_ANONYMIZED_EXCLUSION_REASONS).toContain(anonymized.reason);
        continue;
      }
      expect(anonymized.exposure).toBe("passthrough");
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

  test("no orphan scopes: projected scopes match the advertised anonymized scopes", () => {
    expect([...MCP_ANONYMIZED_PROJECTED_SCOPES].sort()).toEqual(
      [...MCP_ANONYMIZED_RESOURCE_SCOPES].sort(),
    );
  });

  test("every default tool scope is an advertised default scope", () => {
    for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
      expect(MCP_DEFAULT_RESOURCE_SCOPES).toContain(tool.scope);
    }
  });

  test("tool names are unique across the registry", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

import { describe, expect, test } from "bun:test";

import { CAPABILITY_TOOL_SET } from "@/api/mcp/capability-tools";
import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_LAW_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import { DOCUMENT_TOOL_SET } from "@/api/mcp/document-tools";
import {
  ALL_MCP_TOOL_DEFINITIONS,
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  DOCUMENTS_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
  getStaticMcpToolHandler,
  getStaticMcpToolOutputContract,
  LAW_MCP_TOOL_DEFINITIONS,
  LAW_MCP_TOOL_DISPOSITION,
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
      .toSorted();

    const projectedNames = ANONYMIZED_MCP_TOOL_DEFINITIONS.map(
      (tool) => tool.name,
    ).toSorted();

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
    ].toSorted();

    expect(projectedScopes).toEqual(
      [...MCP_ANONYMIZED_RESOURCE_SCOPES].toSorted(),
    );
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

  test("every public-corpus tool carries a law-audience disposition", () => {
    // Every advertised definition, the law audience's own copies of the
    // OpenAI-compatible pair included: a corpus tool only that audience serves
    // still needs a disposition, and the census is what says so.
    const definitions: readonly McpToolDefinition[] = ALL_MCP_TOOL_DEFINITIONS;
    const publicLawNames = definitions
      .filter(
        (tool) =>
          tool.feature === "FEATURE_PUBLIC_LAW" &&
          tool.anonymized.exposure === "passthrough",
      )
      .map((tool) => tool.name);

    // The disposition map's `satisfies Record<PublicLawToolName, ...>` is the
    // real gate, but it goes vacuous if that union ever resolves to `never`
    // (`Record<never, T>` accepts anything), so the census also runs here.
    expect(publicLawNames.length).toBeGreaterThan(0);
    expect(Object.keys(LAW_MCP_TOOL_DISPOSITION).toSorted()).toEqual(
      [...publicLawNames].toSorted(),
    );
  });

  test("law projection is the public corpus in wire order", () => {
    expect(LAW_MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      // The audience's own corpus-only pair, then the named corpus tools in
      // registry order.
      "search",
      "fetch",
      "search_case_law",
      "lookup_case_law",
      "read_case_law_decision",
      "read_case_law_citations",
      "search_legislation",
      "read_statute",
      "read_statute_provisions",
      "read_provision_history",
    ]);
  });

  test("every law tool is a read of the gated public corpus", () => {
    const definitions: readonly McpToolDefinition[] = LAW_MCP_TOOL_DEFINITIONS;
    for (const tool of definitions) {
      expect(tool.access, `${tool.name} is not a read`).toBe("read");
      expect(tool.feature, `${tool.name} is not corpus-gated`).toBe(
        "FEATURE_PUBLIC_LAW",
      );
      // Passthrough is what "carries no tenant or personal text" means in the
      // registry, and it is why this surface needs no egress redaction.
      expect(tool.anonymized.exposure, `${tool.name} is not passthrough`).toBe(
        "passthrough",
      );
      expect(tool.additionalScopes).toBeUndefined();
    }
  });

  test("advertises exactly the scopes the law projection uses", () => {
    const projectedScopes = [
      ...new Set(LAW_MCP_TOOL_DEFINITIONS.map((tool) => tool.scope)),
    ].toSorted();

    expect(projectedScopes).toEqual([...MCP_LAW_RESOURCE_SCOPES].toSorted());
  });

  test("tool names are unique across the registry", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a law-only tool sharing a wire name resolves to its own definition", () => {
    // Both audiences advertise a `search` and a `fetch`. Resolution is per
    // audience, so the law one must never be the matter-reading one; the
    // corpus gate is what tells the two apart.
    for (const toolName of ["search", "fetch"]) {
      const lawTool = getStaticMcpToolDefinition(toolName, "law");
      expect(lawTool?.feature, `law ${toolName}`).toBe("FEATURE_PUBLIC_LAW");
      expect(lawTool).not.toBe(getStaticMcpToolDefinition(toolName, "default"));
      expect(getStaticMcpToolHandler(toolName, "law")).not.toBe(
        getStaticMcpToolHandler(toolName, "default"),
      );
      expect(getStaticMcpToolOutputContract(toolName, "law")).toBeDefined();
    }
  });
});

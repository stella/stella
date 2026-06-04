import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import { normalizeDiscoveredMcpTools } from "@/api/lib/mcp-upstream/cached-tools";
import { shortToolNameHash } from "@/api/lib/mcp-upstream/namespace";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("MCP upstream tool cache", () => {
  test("preserves raw upstream names while exposing sanitized names", () => {
    const tools = normalizeDiscoveredMcpTools({
      connectorSlug: "Legal Data",
      tools: [
        {
          name: "search.company",
          description: "Search companies",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(tools).toEqual([
      {
        description: "Search companies",
        exposedName: "mcp__Legal_Data__search_company",
        inputSchema: { type: "object", properties: {} },
        rawName: "search.company",
      },
    ]);
  });

  test("adds a stable suffix when sanitized upstream names collide", () => {
    const tools = normalizeDiscoveredMcpTools({
      connectorSlug: "ares",
      tools: [
        {
          name: "search.company",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search company",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(tools).toHaveLength(2);
    expect(tools[0]?.rawName).toBe("search.company");
    expect(tools[0]?.exposedName).toBe(
      `mcp__ares__search_company_${shortToolNameHash("search.company")}`,
    );
    expect(tools[1]?.rawName).toBe("search company");
    expect(tools[1]?.exposedName).toBe(
      `mcp__ares__search_company_${shortToolNameHash("search company")}`,
    );
  });

  test("keeps colliding exposed names stable when upstream order changes", () => {
    const tools: Parameters<typeof normalizeDiscoveredMcpTools>[0]["tools"] = [
      {
        name: "search.company",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search company",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const firstOrder = normalizeDiscoveredMcpTools({
      connectorSlug: "ares",
      tools,
    });
    const secondOrder = normalizeDiscoveredMcpTools({
      connectorSlug: "ares",
      tools: tools.toReversed(),
    });

    expect(
      new Map(firstOrder.map((tool) => [tool.rawName, tool.exposedName])),
    ).toEqual(
      new Map(secondOrder.map((tool) => [tool.rawName, tool.exposedName])),
    );
  });

  test("truncates long upstream text while preserving usable context", () => {
    const longDescription = "a".repeat(
      LIMITS.mcpGatewayToolDescriptionMaxChars + 10,
    );

    const tools = normalizeDiscoveredMcpTools({
      connectorSlug: "registry",
      tools: [
        {
          name: "lookup",
          description: longDescription,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(tools.at(0)?.description).toHaveLength(
      LIMITS.mcpGatewayToolDescriptionMaxChars,
    );
  });

  test("rejects circular input schemas without crashing discovery", () => {
    const circularSchema: Record<string, unknown> = { type: "object" };
    circularSchema["self"] = circularSchema;

    const tools = normalizeDiscoveredMcpTools({
      connectorSlug: "registry",
      tools: [
        {
          name: "lookup",
          inputSchema: asTestRaw({ type: "object", self: circularSchema }),
        },
      ],
    });

    expect(tools).toEqual([]);
  });
});

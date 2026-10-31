import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { MCP_REGISTRY_VERSION_HEADER } from "@stll/api-contract/mcp-registry";

import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { McpToolFreshnessRegistry } from "@/api/mcp/tool-freshness";
import { withMcpRegistryVersionHeader } from "@/api/mcp/tool-freshness-response";
import {
  MCP_TOOL_SCHEMA_VERSION_META_KEY,
  mcpRegistryVersion,
  mcpToolSchemaVersion,
  withMcpToolSchemaVersion,
} from "@/api/mcp/tool-versions";

const tool = (description = "Search admitted law"): Tool => ({
  annotations: { readOnlyHint: true, title: "Search law" },
  description,
  inputSchema: { properties: { query: { type: "string" } }, type: "object" },
  name: "search_law",
  outputSchema: { properties: { result: { type: "string" } }, type: "object" },
  title: "Search law",
});

describe("MCP tool freshness", () => {
  test("does not notify when nothing visible to a session changed", async () => {
    const registry = new McpToolFreshnessRegistry();
    const notifications: string[] = [];
    registry.register({
      id: "unchanged",
      notifyToolsChanged: () => {
        notifications.push("unchanged");
      },
      organizationId: "org",
      projectTools: async () => [tool()],
      tools: [tool()],
      userId: "user",
    });
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual([]);
  });

  test("notifies only the session whose admission changed its visible tools", async () => {
    const registry = new McpToolFreshnessRegistry();
    const notifications: string[] = [];
    const expanded = [tool(), { ...tool(), name: "search_legislation" }];
    registry.register({
      id: "newly-admitted",
      notifyToolsChanged: () => {
        notifications.push("newly-admitted");
      },
      organizationId: "org",
      projectTools: async () => expanded,
      tools: [tool()],
      userId: "user",
    });
    registry.register({
      id: "already-admitted",
      notifyToolsChanged: () => {
        notifications.push("already-admitted");
      },
      organizationId: "org",
      projectTools: async () => expanded,
      tools: expanded,
      userId: "user",
    });
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["newly-admitted"]);
  });

  test("notification failure never rejects the triggering publication", async () => {
    const registry = new McpToolFreshnessRegistry();
    registry.register({
      id: "broken",
      notifyToolsChanged: async () =>
        await Promise.reject(new Error("closed stream")),
      organizationId: "org",
      projectTools: async () => [tool("Expanded admission")],
      tools: [tool()],
      userId: "user",
    });
    await registry.publish({ organizationId: "org" });
  });

  test("per-tool versions change for every and only advertised contract field", () => {
    const original = tool();
    const version = mcpToolSchemaVersion(original);
    const contractChanges: Tool[] = [
      { ...original, name: "search_legislation" },
      { ...original, title: "Search legislation" },
      { ...original, description: "Search admitted legislation" },
      { ...original, inputSchema: { properties: {}, type: "object" } },
      { ...original, outputSchema: { properties: {}, type: "object" } },
      { ...original, annotations: { readOnlyHint: false } },
    ];
    for (const changed of contractChanges) {
      expect(mcpToolSchemaVersion(changed)).not.toBe(version);
    }
    expect(
      mcpToolSchemaVersion({ ...original, _meta: { private: true } }),
    ).toBe(version);
    expect(version).toMatch(/^[a-f0-9]{16}$/u);
    expect(
      withMcpToolSchemaVersion(original)._meta?.[
        MCP_TOOL_SCHEMA_VERSION_META_KEY
      ],
    ).toBe(version);
  });

  test("the compact version prefix has no collisions in the registered surface", () => {
    const tools = toMcpTools(ALL_MCP_TOOL_DEFINITIONS, { mode: "advanced" });
    const versions = tools.map(mcpToolSchemaVersion);
    expect(new Set(versions).size).toBe(tools.length);
  });

  test("the response header equals the returned projection version", () => {
    const tools = [tool()];
    const projectionVersion = mcpRegistryVersion(tools);
    const response = withMcpRegistryVersionHeader(
      new Response(JSON.stringify({ tools })),
      projectionVersion,
    );
    expect(response.headers.get(MCP_REGISTRY_VERSION_HEADER)).toBe(
      projectionVersion,
    );
  });

  test("jurisdiction descriptions match the registered admissions", () => {
    const descriptions: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "description" && typeof child === "string") {
          descriptions.push(child);
        } else {
          visit(child);
        }
      }
    };
    for (const definition of ALL_MCP_TOOL_DEFINITIONS) {
      visit(definition.inputSchema);
    }
    const advertised = descriptions
      .map((description) => /Admitted: ([A-Z, ]+)\./u.exec(description)?.[1])
      .filter((value) => value !== undefined);
    expect(advertised.length).toBeGreaterThan(0);
    expect(new Set(advertised)).toEqual(
      new Set([
        PUBLIC_CASE_LAW_COUNTRIES.join(", "),
        PUBLIC_LEGISLATION_COUNTRIES.join(", "),
      ]),
    );
  });
});

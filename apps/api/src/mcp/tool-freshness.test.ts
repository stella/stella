import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { McpToolFreshnessRegistry } from "@/api/mcp/tool-freshness";
import {
  MCP_TOOL_SCHEMA_VERSION_META_KEY,
  mcpRegistryVersion,
  mcpToolSchemaVersion,
  withMcpToolSchemaVersion,
} from "@/api/mcp/tool-versions";

const tool = (description: string): Tool => ({
  annotations: { readOnlyHint: true, title: "Search law" },
  description,
  inputSchema: { properties: { query: { type: "string" } }, type: "object" },
  name: "search_law",
  outputSchema: { properties: { result: { type: "string" } }, type: "object" },
  title: "Search law",
});

describe("MCP tool freshness", () => {
  test("signals only sessions whose visible projection changed", async () => {
    const registry = new McpToolFreshnessRegistry();
    const notifications: string[] = [];
    registry.register({
      id: "changed",
      notifyToolsChanged: () => {
        notifications.push("changed");
      },
      tools: [tool("Admitted: CZE")],
    });
    registry.register({
      id: "unchanged",
      notifyToolsChanged: () => {
        notifications.push("unchanged");
      },
      tools: [tool("Admitted: CZE, SVK")],
    });

    await registry.publish(async () => [tool("Admitted: CZE, SVK")]);
    expect(notifications).toEqual(["changed"]);

    await registry.publish(async () => [tool("Admitted: CZE, SVK")]);
    expect(notifications).toEqual(["changed"]);
  });

  test("notification failure never rejects the triggering publication", async () => {
    const registry = new McpToolFreshnessRegistry();
    registry.register({
      id: "broken",
      notifyToolsChanged: async () =>
        await Promise.reject(new Error("closed stream")),
      tools: [tool("Admitted: CZE")],
    });
    await registry.publish(async () => [tool("Admitted: CZE, SVK")]);
  });

  test("tool and registry versions follow only the advertised contract", () => {
    const original = tool("Admitted: CZE");
    const metadataOnly = { ...original, _meta: { private: "ignored" } };
    const changed = tool("Admitted: CZE, SVK");

    expect(mcpToolSchemaVersion(metadataOnly)).toBe(
      mcpToolSchemaVersion(original),
    );
    expect(mcpToolSchemaVersion(changed)).not.toBe(
      mcpToolSchemaVersion(original),
    );
    expect(
      withMcpToolSchemaVersion(original)._meta?.[
        MCP_TOOL_SCHEMA_VERSION_META_KEY
      ],
    ).toBe(mcpToolSchemaVersion(original));
    expect(mcpRegistryVersion([original])).not.toBe(
      mcpRegistryVersion([changed]),
    );
  });
});

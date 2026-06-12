import { toolDefinition } from "@tanstack/ai";
import type { ServerTool } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { ChatTool } from "@/api/handlers/chat/tools/chat-tool-types";
import { selectAllowedExternalMcpToolDefinitions } from "@/api/handlers/chat/tools/external-mcp-tool-definitions";
import { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";

const tool = (name: string): ChatTool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: "object",
    properties: {},
  },
});

const approvalTool = (name: string): ChatTool => ({
  ...tool(name),
  needsApproval: true,
});

describe("external MCP chat tools", () => {
  test("filters by raw MCP tool name before namespacing", () => {
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: ["lookup"],
      connectorSlug: "ares",
      tools: [tool("lookup"), tool("deleteEverything")],
    });

    expect(normalized.toolNames).toEqual(["lookup"]);
    expect(Object.keys(normalized.tools)).toEqual(["mcp__ares__lookup"]);
  });

  test("marks exposed tools for TanStack lazy discovery without mutating originals", () => {
    const original = approvalTool("search");

    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: null,
      connectorSlug: "public registry",
      tools: [original],
    });

    const exposed = normalized.tools["mcp__public_registry__search"];
    expect(original.name).toBe("search");
    expect(original.lazy).toBeUndefined();
    expect(exposed?.name).toBe("mcp__public_registry__search");
    expect(exposed?.lazy).toBe(true);
    expect(exposed?.needsApproval).toBe(true);
  });
});

describe("Stella MCP tool source", () => {
  test("satisfies TanStack MCP lifecycle and preserves lazy discovery by default", async () => {
    const source = createStellaMcpToolSource({
      closeClients: async () => {},
      sourceTools: {
        mcp__registry__lookup: serverTool("mcp__registry__lookup"),
      },
    });

    const tools = await source.tools();

    expect(tools).toEqual([
      expect.objectContaining({
        __toolSide: "server",
        lazy: true,
        name: "mcp__registry__lookup",
      }),
    ]);
  });

  test("can return eager tools when TanStack asks for eager MCP discovery", async () => {
    const source = createStellaMcpToolSource({
      closeClients: async () => {},
      sourceTools: {
        mcp__registry__lookup: serverTool("mcp__registry__lookup"),
      },
    });

    const tools = await source.tools({ lazy: false });

    expect(tools).toEqual([expect.not.objectContaining({ lazy: true })]);
  });
});

describe("external MCP typed definitions", () => {
  test("filters explicit TanStack tool definitions by the connector allowlist", () => {
    const lookup = toolDefinition({
      name: "lookup",
      description: "Lookup a record",
      inputSchema: { type: "object", properties: {} },
    });
    const deleteRecord = toolDefinition({
      name: "delete_record",
      description: "Delete a record",
      inputSchema: { type: "object", properties: {} },
    });

    expect(
      selectAllowedExternalMcpToolDefinitions({
        allowedTools: ["lookup"],
        definitions: [lookup, deleteRecord],
      }),
    ).toEqual([lookup]);
  });
});

const serverTool = (name: string): ServerTool => ({
  __toolSide: "server",
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: "object",
    properties: {},
  },
  lazy: true,
});

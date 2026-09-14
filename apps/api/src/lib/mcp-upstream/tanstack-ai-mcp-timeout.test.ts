import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolDefinition } from "@tanstack/ai";
import { createMCPClientFromTransport } from "@tanstack/ai-mcp";
import type { Transport } from "@tanstack/ai-mcp";
import { expect, spyOn, test } from "bun:test";

test("a tool-specific timeout reaches the MCP SDK protocol request", async () => {
  const transport: Transport = {
    close: async () => {
      transport.onclose?.();
    },
    send: async (message) => {
      if (!("method" in message) || !("id" in message)) {
        return;
      }

      if (message.method === "initialize") {
        transport.onmessage?.({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-06-18",
            serverInfo: { name: "timeout-test", version: "1.0.0" },
          },
        });
        return;
      }

      if (message.method === "tools/list") {
        transport.onmessage?.({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              {
                inputSchema: { properties: {}, type: "object" },
                name: "slow_tool",
              },
            ],
          },
        });
        return;
      }
    },
    start: async () => undefined,
  };

  const client = await createMCPClientFromTransport(transport);
  const tools = await client.tools(
    [
      toolDefinition({
        description: "Wait before returning a result",
        inputSchema: { properties: {}, type: "object" },
        name: "slow_tool",
      }),
    ],
    { callToolTimeoutMs: 5 * 60_000 },
  );
  const tool = tools.at(0);
  if (!tool) {
    throw new Error("The MCP client did not bind the tool");
  }
  if (!tool.execute) {
    throw new Error("The bound MCP tool is not executable");
  }
  const callTool = spyOn(Client.prototype, "callTool").mockResolvedValue({
    content: [{ text: "completed", type: "text" }],
  });

  expect(await tool.execute({})).toBe("completed");
  expect(callTool.mock.calls).toEqual([
    [{ arguments: {}, name: "slow_tool" }, undefined, { timeout: 5 * 60_000 }],
  ]);
  callTool.mockRestore();
  await client.close();
});

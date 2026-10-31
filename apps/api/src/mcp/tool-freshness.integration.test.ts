import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  getMcpToolFreshnessRegistry,
  publishMcpToolProjectionChange,
} from "@/api/mcp/tool-freshness";

const baseTool: Tool = {
  description: "Search law",
  inputSchema: { type: "object" },
  name: "search_law",
};
const admittedTool: Tool = {
  description: "Search legislation",
  inputSchema: { type: "object" },
  name: "search_legislation",
};

const connectClient = async () => {
  let admitted = false;
  const context = { marker: "freshness-context" };
  const resolveContext = mock();
  resolveContext.mockResolvedValue(context);
  const dependencies = {
    actionSizePolicy: () => Result.ok(undefined),
    authenticateMcpRequest: async () =>
      Result.ok({
        organizationId: "org_freshness",
        scopes: ["stella:read"],
        userId: "user_freshness",
      }),
    captureError: mock(() => undefined),
    getMcpToolDefinition: async () => undefined,
    getMcpToolRequiredScopesHint: () => undefined,
    handleMcpToolCall: async () => ({ content: [] }),
    listMcpResources: async () => [],
    listMcpTools: async () =>
      admitted ? [baseTool, admittedTool] : [baseTool],
    readMcpResource: async () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: resolveContext,
  } satisfies Parameters<typeof createMcpHttpRequestHandler>[0];
  const handler = createMcpHttpRequestHandler(dependencies);
  const transportFetch: FetchLike = async (input, init) =>
    await handler(new Request(input.toString(), init));
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      fetch: transportFetch,
      requestInit: { headers: { authorization: "Bearer token" } },
    },
  );
  const client = new Client({ name: "freshness-test", version: "1.0.0" });
  const notifications: string[] = [];
  const notificationReceived = Promise.withResolvers<true>();
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications.push("changed");
    notificationReceived.resolve(true);
  });
  await client.connect(transport, { timeout: 2000 });
  await client.listTools(undefined, { timeout: 2000 });
  return {
    admit: () => {
      admitted = true;
    },
    client,
    notificationReceived: notificationReceived.promise,
    notifications,
  };
};

test("a live MCP client receives a tool-list change after its projection changes", async () => {
  const before = getMcpToolFreshnessRegistry().size;
  const connection = await connectClient();
  try {
    expect(getMcpToolFreshnessRegistry().size).toBe(before + 1);
    connection.admit();
    await publishMcpToolProjectionChange({
      organizationId: "org_freshness",
      userId: "user_freshness",
    });
    await connection.notificationReceived;
    expect(connection.notifications).toEqual(["changed"]);
  } finally {
    await connection.client.close();
  }
});

test("a disconnected MCP client is removed and receives no notification", async () => {
  const before = getMcpToolFreshnessRegistry().size;
  const connection = await connectClient();
  expect(getMcpToolFreshnessRegistry().size).toBe(before + 1);
  await connection.client.close();
  expect(getMcpToolFreshnessRegistry().size).toBe(before);
  connection.admit();
  await publishMcpToolProjectionChange({
    organizationId: "org_freshness",
    userId: "user_freshness",
  });
  expect(connection.notifications).toEqual([]);
});

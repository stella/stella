import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
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

const publishChange = async () => {
  await publishMcpToolProjectionChange({
    organizationId: toSafeId<"organization">("org_freshness"),
    userId: toSafeId<"user">("user_freshness"),
  });
};

const connectClient = async ({
  clientOptions = {},
  listTools = true,
  toolListOutage = false,
}: {
  clientOptions?: ConstructorParameters<typeof Client>[1];
  /** Whether the client lists its tools before it is handed back. */
  listTools?: boolean;
  /** Whether listing tools fails until `restoreToolList` is called. */
  toolListOutage?: boolean;
} = {}) => {
  let admitted = false;
  let outage = toolListOutage;
  const failedListing = Promise.withResolvers<undefined>();
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
    listMcpTools: async () => {
      if (outage) {
        failedListing.resolve(undefined);
        throw new Error("tool list unavailable");
      }
      return admitted ? [baseTool, admittedTool] : [baseTool];
    },
    readMcpResource: async () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: resolveContext,
  } satisfies Parameters<typeof createMcpHttpRequestHandler>[0];
  const handler = createMcpHttpRequestHandler(dependencies);
  const notificationStream = Promise.withResolvers<{
    request: Request;
    response: Response;
  }>();
  const transportFetch: FetchLike = async (input, init) => {
    const request = new Request(input.toString(), init);
    const response = await handler(request);
    if (request.method === "GET") {
      notificationStream.resolve({ request, response });
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      fetch: transportFetch,
      requestInit: { headers: { authorization: "Bearer token" } },
    },
  );
  const client = new Client(
    { name: "freshness-test", version: "1.0.0" },
    clientOptions,
  );
  const notifications: string[] = [];
  const waiters: { count: number; reached: () => void }[] = [];
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications.push("changed");
    for (const waiter of waiters) {
      if (notifications.length >= waiter.count) {
        waiter.reached();
      }
    }
  });
  /** Settles once the client has received `count` tool-list changes. */
  const notificationsReceived = async (count: number): Promise<void> => {
    if (notifications.length >= count) {
      return;
    }
    const reached = Promise.withResolvers<undefined>();
    waiters.push({ count, reached: () => reached.resolve(undefined) });
    await reached.promise;
  };
  await client.connect(transport, { timeout: 2000 });
  if (listTools) {
    await client.listTools(undefined, { timeout: 2000 });
  }
  return {
    admit: () => {
      admitted = true;
    },
    client,
    failedListing: failedListing.promise,
    handler,
    notificationStream: notificationStream.promise,
    notifications,
    notificationsReceived,
    restoreToolList: () => {
      outage = false;
    },
  };
};

test("an opened stream is told to list again, then receives each later change", async () => {
  const before = getMcpToolFreshnessRegistry().size;
  const connection = await connectClient();
  try {
    expect(getMcpToolFreshnessRegistry().size).toBe(before + 1);
    // The client listed before its stream opened, so it is told once.
    await connection.notificationsReceived(1);
    connection.admit();
    await publishChange();
    await connection.notificationsReceived(2);
    expect(connection.notifications).toEqual(["changed", "changed"]);
  } finally {
    await connection.client.close();
  }
});

test("a disconnected MCP client is removed and receives no notification", async () => {
  const before = getMcpToolFreshnessRegistry().size;
  const connection = await connectClient();
  expect(getMcpToolFreshnessRegistry().size).toBe(before + 1);
  await connection.notificationsReceived(1);
  await connection.client.close();
  expect(getMcpToolFreshnessRegistry().size).toBe(before);
  connection.admit();
  await publishChange();
  expect(connection.notifications).toEqual(["changed"]);
});

test("a stream opened while the tool list fails stays open and receives the next change", async () => {
  const before = getMcpToolFreshnessRegistry().size;
  const connection = await connectClient({
    listTools: false,
    toolListOutage: true,
  });
  try {
    const { response } = await connection.notificationStream;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await connection.failedListing;
    expect(getMcpToolFreshnessRegistry().size).toBe(before + 1);
    connection.restoreToolList();
    connection.admit();
    await publishChange();
    await connection.notificationsReceived(1);
  } finally {
    await connection.client.close();
  }
});

test("a stream whose client left during setup is torn down and drops its registration", async () => {
  const connection = await connectClient();
  try {
    const { request } = await connection.notificationStream;
    const before = getMcpToolFreshnessRegistry().size;
    const response = await connection.handler(
      new Request(request, { signal: AbortSignal.abort() }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // The body ends only once the exchange is torn down.
    await response.text();
    expect(getMcpToolFreshnessRegistry().size).toBe(before);
  } finally {
    await connection.client.close();
  }
});

test("only a connection that receives tool-list changes advertises them", async () => {
  const legacy = await connectClient();
  try {
    expect(legacy.client.getServerCapabilities()?.tools?.listChanged).toBe(
      true,
    );
  } finally {
    await legacy.client.close();
  }
  const modern = await connectClient({
    clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  });
  try {
    expect(modern.client.getServerCapabilities()?.tools).toEqual({});
  } finally {
    await modern.client.close();
  }
});

import type { MCPClient } from "@tanstack/ai-mcp";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";

const loadActiveMcpConnectionsForUserMock = mock();
const createMcpClientForConnectionMock = mock();
const captureErrorMock = mock();
const withTimeoutMock =
  mock<
    (
      operation: () => Promise<unknown>,
      opts: { label: string; timeoutMs: number },
    ) => Promise<unknown>
  >();

void mock.module("@/api/lib/mcp-upstream/connections", () => ({
  createMcpClientForConnection: createMcpClientForConnectionMock,
  loadActiveMcpConnectionsForUser: loadActiveMcpConnectionsForUserMock,
}));

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

void mock.module("@/api/lib/with-timeout", () => ({
  withTimeout: withTimeoutMock,
}));

const { loadExternalMcpToolsForUser } =
  await import("@/api/handlers/chat/tools/external-mcp-tools");

const orgId = toSafeId<"organization">("org-test");
const userId = toSafeId<"user">("user-test");
// SAFETY: test double — every call this suite exercises is mocked at the
// `mcp-upstream/connections` module boundary, so `safeDb` is never touched.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const stubSafeDb = (() => {
  throw new Error("safeDb stub must not be called");
}) as unknown as SafeDb;

type FakeMcpClient = {
  close: ReturnType<typeof mock<() => Promise<void>>>;
  tools: ReturnType<typeof mock<() => Promise<never[]>>>;
};

const buildRow = (): LoadedMcpConnection => ({
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector-test"),
  description: "Test connector",
  displayName: "Test Connector",
  slug: "test-connector",
  type: "none",
  url: "https://mcp.example.test",
  userConnectionId: toSafeId<"mcpUserConnection">("connection-test"),
});

const buildFakeClient = (
  overrides: Partial<FakeMcpClient> = {},
): FakeMcpClient => ({
  close: mock(async () => undefined),
  tools: mock(async () => []),
  ...overrides,
});

const createDeferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
};

// SAFETY: test double — the fake client's `close`/`tools` cover the only
// members `loadConnectorTools` exercises; the rest of the `MCPClient`
// surface (resources, prompts, callTool, ...) is intentionally
// unimplemented.
const asMcpClient = (client: FakeMcpClient): MCPClient =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test double; MCPClient's full surface isn't exercised by loadConnectorTools
  client as unknown as MCPClient;

const passThroughTimeout = async (
  operation: () => Promise<unknown>,
): Promise<unknown> => await operation();

beforeEach(() => {
  loadActiveMcpConnectionsForUserMock.mockReset();
  createMcpClientForConnectionMock.mockReset();
  captureErrorMock.mockReset();
  withTimeoutMock.mockReset();
  withTimeoutMock.mockImplementation(passThroughTimeout);
});

describe("loadExternalMcpToolsForUser client lifecycle", () => {
  test("closes the MCP client when discovery fails after the client is created", async () => {
    const row = buildRow();
    loadActiveMcpConnectionsForUserMock.mockResolvedValue([row]);

    const fakeClient = buildFakeClient({
      tools: mock(async () => {
        throw new Error("upstream tools() call failed");
      }),
    });
    createMcpClientForConnectionMock.mockResolvedValue(asMcpClient(fakeClient));

    const loaded = await loadExternalMcpToolsForUser({
      nullUnionStrategy: "json-schema",
      organizationId: orgId,
      safeDb: stubSafeDb,
      userId,
    });

    expect(loaded.connectors).toEqual([]);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "external-mcp-tools",
        connectorSlug: "test-connector",
      }),
    );

    // The whole-load `close()` never learned about this client (discovery
    // discarded it before returning), so it must not double-close.
    await loaded.close();
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  test("closes the MCP client when it settles late after a discovery timeout", async () => {
    const row = buildRow();
    loadActiveMcpConnectionsForUserMock.mockResolvedValue([row]);

    const clientCreation = createDeferred<MCPClient>();
    const closeCalled = createDeferred<undefined>();
    const fakeClient = buildFakeClient({
      close: mock(async () => {
        closeCalled.resolve(undefined);
      }),
    });
    createMcpClientForConnectionMock.mockReturnValue(clientCreation.promise);

    withTimeoutMock.mockImplementation(async (operation, opts) => {
      // Mirrors the real `withTimeout`: the timer wins the race and the
      // caller moves on, but the still-running `operation()` (the
      // `discovery` promise) is left to settle on its own.
      void operation();
      throw new TimeoutError({
        message: `${opts.label} exceeded ${opts.timeoutMs}ms`,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
      });
    });

    const loaded = await loadExternalMcpToolsForUser({
      nullUnionStrategy: "json-schema",
      organizationId: orgId,
      safeDb: stubSafeDb,
      userId,
    });

    // The connector is discarded immediately: the caller never sees this
    // client, so it can only be closed by the abandoned-discovery path.
    expect(loaded.connectors).toEqual([]);
    expect(fakeClient.close).not.toHaveBeenCalled();

    // Discovery settles well after the timeout already gave up on it.
    clientCreation.resolve(asMcpClient(fakeClient));
    await closeCalled.promise;

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  test("closes the MCP client immediately on timeout when the client was already created and tools() is the hung step", async () => {
    const row = buildRow();
    loadActiveMcpConnectionsForUserMock.mockResolvedValue([row]);

    // Never resolves — simulates `client.tools()` (not client creation)
    // being the step that hangs past the aggregate discovery timeout.
    const hangingTools = createDeferred<never[]>();
    const fakeClient = buildFakeClient({
      tools: mock(async () => await hangingTools.promise),
    });
    createMcpClientForConnectionMock.mockResolvedValue(asMcpClient(fakeClient));

    withTimeoutMock.mockImplementation(async (operation, opts) => {
      // Mirrors the real `withTimeout`, but flushes microtasks first so the
      // still-running `discovery` promise has a chance to resolve
      // `createMcpClientForConnection` (already-resolved) and assign its
      // closure's `client` variable before hanging on `client.tools()` —
      // otherwise this test could not distinguish "client known" from
      // "client not yet created" at the moment the timeout fires.
      void operation();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      throw new TimeoutError({
        message: `${opts.label} exceeded ${opts.timeoutMs}ms`,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
      });
    });

    const loaded = await loadExternalMcpToolsForUser({
      nullUnionStrategy: "json-schema",
      organizationId: orgId,
      safeDb: stubSafeDb,
      userId,
    });

    expect(loaded.connectors).toEqual([]);
    // The client was already known when the timeout fired, so it is closed
    // right away — the fix does not wait for the permanently-hung
    // `tools()` call to settle before closing the leaked client/sockets.
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });
});

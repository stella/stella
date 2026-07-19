import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const loadActiveMcpConnectionsForUserMock = mock();
const refreshCachedMcpToolsForConnectionMock = mock(async () => undefined);
const proxyMcpToolCallMock = mock();

void mock.module("@/api/lib/mcp-upstream/connections", () => ({
  loadActiveMcpConnectionsForUser: loadActiveMcpConnectionsForUserMock,
  proxyMcpToolCall: proxyMcpToolCallMock,
  refreshCachedMcpToolsForConnection: refreshCachedMcpToolsForConnectionMock,
}));

const { callGatewayExternalMcpTool, listGatewayExternalMcpTools } =
  await import("@/api/mcp/gateway/external-tools");

type GatewayConnectionToolRow = {
  allowedTools: string[] | null;
  cachedTools: CachedMcpToolDefinition[] | null;
  connectorId: SafeId<"mcpConnector">;
  displayName: string;
  slug: string;
  userConnectionId: SafeId<"mcpUserConnection">;
};

const connectionId = toSafeId<"mcpUserConnection">("conn_1");
const connectorId = toSafeId<"mcpConnector">("connector_1");
const cachedTool = {
  exposedName: "mcp__registry__lookup",
  inputSchema: { type: "object", properties: {} },
  rawName: "lookup",
} satisfies CachedMcpToolDefinition;

const row = ({
  cachedTools,
}: {
  cachedTools: CachedMcpToolDefinition[] | null;
}): GatewayConnectionToolRow => ({
  allowedTools: null,
  cachedTools,
  connectorId,
  displayName: "Registry",
  slug: "registry",
  userConnectionId: connectionId,
});

const activeConnection = {
  allowedTools: null,
  connectorId,
  description: "Registry connector",
  displayName: "Registry",
  slug: "registry",
  type: "none",
  url: "https://mcp.example.test",
  userConnectionId: connectionId,
} satisfies LoadedMcpConnection;

const createSelectBuilder = (rowBatches: GatewayConnectionToolRow[][]) => {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    limit: async () => rowBatches.shift() ?? [],
    orderBy: () => builder,
    where: () => builder,
  };
  return builder;
};

const createContext = (
  rowBatches: GatewayConnectionToolRow[][],
): McpRequestContext => {
  const tx = {
    select: () => createSelectBuilder(rowBatches),
  };
  const scopedDb: ScopedDb = async <T>(
    callback: (transaction: Transaction) => Promise<T>,
    // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
  ) => await callback(asTestRaw<Transaction>(tx));
  const safeDb: McpRequestContext["safeDb"] = async (callback) =>
    // oxlint-disable-next-line node/callback-return -- result must be wrapped in Result.ok, not returned raw
    Result.ok(await callback(asTestRaw<Transaction>(tx)));

  return {
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

/** Context whose backing-store read always fails (transient DB outage). */
const createFailingContext = (): McpRequestContext => {
  const base = createContext([]);
  const safeDb: McpRequestContext["safeDb"] = async () =>
    Result.err(new DatabaseError({ message: "connection refused" }));
  return { ...base, safeDb };
};

describe("external MCP gateway tools", () => {
  beforeEach(() => {
    loadActiveMcpConnectionsForUserMock.mockReset();
    loadActiveMcpConnectionsForUserMock.mockResolvedValue([activeConnection]);
    proxyMcpToolCallMock.mockReset();
    refreshCachedMcpToolsForConnectionMock.mockReset();
    refreshCachedMcpToolsForConnectionMock.mockResolvedValue(undefined);
  });

  test("refreshes missing cached tools before exposing existing connections", async () => {
    const context = createContext([
      [row({ cachedTools: null })],
      [row({ cachedTools: [cachedTool] })],
    ]);

    const tools = await listGatewayExternalMcpTools({ context });

    expect(refreshCachedMcpToolsForConnectionMock).toHaveBeenCalledWith({
      connectionId,
      organizationId: context.organizationId,
      safeDb: context.safeDb,
      userId: context.userId,
    });
    expect(tools).toHaveLength(1);
    expect(tools.at(0)?.cachedTool.rawName).toBe("lookup");
    expect(tools.at(0)?.connection).toEqual(activeConnection);
  });

  test("propagates a backing-store load fault instead of shrinking to an empty list", async () => {
    const context = createFailingContext();

    // A DB outage must not be mistaken for "no connectors": the loader throws a
    // distinct fault so tools/list fails loudly rather than silently dropping
    // every external tool.
    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await listGatewayExternalMcpTools({
      context,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(McpGatewayLoadError);
  });

  test("answers a call with a retryable internal_error, not unknown_tool, when the load fails", async () => {
    const context = createFailingContext();

    const result = await callGatewayExternalMcpTool({
      args: {},
      context,
      toolName: "mcp__registry__lookup",
    });

    const item = result.content.at(0);
    const parsed = item?.type === "text" ? JSON.parse(item.text) : undefined;
    expect(parsed.error.code).toBe("internal_error");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.code).not.toBe("unknown_tool");
    expect(result.isError).toBe(true);
  });
});

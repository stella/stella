import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const loadActiveMcpConnectionsForUserMock = mock();
const refreshCachedMcpToolsForConnectionMock = mock(async () => undefined);
const proxyMcpToolCallMock = mock();

void mock.module("@/api/lib/mcp-upstream/connections", () => ({
  loadActiveMcpConnectionsForUser: loadActiveMcpConnectionsForUserMock,
  proxyMcpToolCall: proxyMcpToolCallMock,
  refreshCachedMcpToolsForConnection: refreshCachedMcpToolsForConnectionMock,
}));

const { listGatewayExternalMcpTools } =
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
  ) => await callback(asTestRaw<Transaction>(tx));
  const safeDb: McpRequestContext["safeDb"] = async (callback) =>
    Result.ok(await callback(asTestRaw<Transaction>(tx)));

  return {
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
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
});

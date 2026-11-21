import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import createMcpConnection from "@/api/handlers/mcp-connectors/create-connection";
import { createDeleteMcpConnectionHandler } from "@/api/handlers/mcp-connectors/delete-connection";
import updateMcpConnection from "@/api/handlers/mcp-connectors/update-connection";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const connectorId = toSafeId<"mcpConnector">("connector_1");
const connectionId = toSafeId<"mcpUserConnection">("connection_1");
const STATIC_TOKEN = "static-token-value";

type Chain = Record<string, unknown>;

// A fluent stand-in for the drizzle builder: every step returns the chain and
// the terminal steps resolve to the rows the scenario supplies.
const chainResolving = ({
  limit = [],
  returning = [],
}: {
  limit?: unknown[];
  returning?: unknown[];
}): Chain => {
  const chain: Chain = {};
  for (const step of [
    "select",
    "from",
    "where",
    "insert",
    "values",
    "onConflictDoUpdate",
    "update",
    "set",
    "delete",
  ]) {
    chain[step] = () => chain;
  }
  chain["limit"] = async () => await Promise.resolve(limit);
  chain["returning"] = async () => await Promise.resolve(returning);
  return chain;
};

const baseContext = ({
  audits,
  safeDb,
}: {
  audits: unknown[];
  safeDb: (operation: (tx: Chain) => Promise<unknown>) => Promise<unknown>;
}) => ({
  safeDb,
  session: { activeOrganizationId: organizationId },
  user: { id: userId },
  memberRole: sessionMemberRole("member"),
  recordAuditEvent: async (_tx: unknown, event: unknown) => {
    audits.push(event);
    await Promise.resolve();
  },
});

describe("per-user MCP connection audit trail", () => {
  test("a bearer connection records a create row without the token", async () => {
    const audits: unknown[] = [];
    let calls = 0;
    type Context = Parameters<typeof createMcpConnection.handler>[0];
    const context = asTestRaw<Context>({
      ...baseContext({
        audits,
        // Connector lookup, then the upsert. Later reads (tool-cache refresh)
        // fail so the test never reaches an upstream server.
        safeDb: async (operation) => {
          calls += 1;
          if (calls === 1) {
            return Result.ok(
              await operation(
                chainResolving({
                  limit: [
                    {
                      id: connectorId,
                      authType: "bearer",
                      url: "https://connector.example.test/mcp",
                    },
                  ],
                }),
              ),
            );
          }
          if (calls === 2) {
            return Result.ok(
              await operation(
                chainResolving({
                  returning: [{ id: connectionId, status: "connected" }],
                }),
              ),
            );
          }
          return Result.err(new DatabaseError({ message: "not in fixture" }));
        },
      }),
      body: { connectorSlug: "registry", token: STATIC_TOKEN },
      request: new Request("https://api.example.test/v1/mcp/connections", {
        method: "POST",
      }),
      route: "/v1/mcp/connections" satisfies ApiRoutePath,
    });

    expect(await createMcpConnection.handler(context)).toEqual({
      id: connectionId,
      status: "connected",
    });
    expect(audits).toEqual([
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
        resourceId: connectionId,
        workspaceId: null,
        metadata: {
          connectorId,
          connectorSlug: "registry",
          credential: "static_token",
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(STATIC_TOKEN);
  });

  test("toggling a connection records the new enabled state", async () => {
    const audits: unknown[] = [];
    type Context = Parameters<typeof updateMcpConnection.handler>[0];
    const context = asTestRaw<Context>({
      ...baseContext({
        audits,
        safeDb: async (operation) =>
          Result.ok(
            await operation(
              chainResolving({
                returning: [
                  {
                    id: connectionId,
                    connectorId,
                    enabled: false,
                    status: "connected",
                  },
                ],
              }),
            ),
          ),
      }),
      params: { connectionId },
      body: { enabled: false },
      request: new Request(
        `https://api.example.test/v1/mcp/connections/${connectionId}`,
        { method: "PATCH" },
      ),
      route: "/v1/mcp/connections/:connectionId" satisfies ApiRoutePath,
    });

    expect(await updateMcpConnection.handler(context)).toEqual({
      id: connectionId,
      enabled: false,
      status: "connected",
    });
    expect(audits).toEqual([
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
        resourceId: connectionId,
        workspaceId: null,
        metadata: { connectorId, enabled: false, operation: "set_enabled" },
      },
    ]);
  });

  test("a missing connection records nothing", async () => {
    const audits: unknown[] = [];
    type Context = Parameters<typeof updateMcpConnection.handler>[0];
    const context = asTestRaw<Context>({
      ...baseContext({
        audits,
        safeDb: async (operation) =>
          Result.ok(await operation(chainResolving({ returning: [] }))),
      }),
      params: { connectionId },
      body: { enabled: true },
      request: new Request(
        `https://api.example.test/v1/mcp/connections/${connectionId}`,
        { method: "PATCH" },
      ),
      route: "/v1/mcp/connections/:connectionId" satisfies ApiRoutePath,
    });

    expect(await updateMcpConnection.handler(context)).toMatchObject({
      code: 404,
    });
    expect(audits).toEqual([]);
  });

  test("disconnecting records a delete row", async () => {
    const audits: unknown[] = [];
    const deleteMcpConnection = createDeleteMcpConnectionHandler({
      revocableMcpConnectionFromDeleted: async () =>
        await Promise.resolve(Result.ok(null)),
      revokeMcpConnectionTokens: async () =>
        await Promise.reject(new Error("not reached without a loaded row")),
    });
    type Context = Parameters<typeof deleteMcpConnection.handler>[0];
    const context = asTestRaw<Context>({
      ...baseContext({
        audits,
        safeDb: async (operation) =>
          Result.ok(
            await operation(
              chainResolving({
                returning: [{ userConnectionId: connectionId, connectorId }],
              }),
            ),
          ),
      }),
      params: { connectionId },
      request: new Request(
        `https://api.example.test/v1/mcp/connections/${connectionId}`,
        { method: "DELETE" },
      ),
      route: "/v1/mcp/connections/:connectionId" satisfies ApiRoutePath,
    });

    expect(await deleteMcpConnection.handler(context)).toEqual({
      id: connectionId,
    });
    expect(audits).toEqual([
      {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
        resourceId: connectionId,
        workspaceId: null,
        metadata: { connectorId },
      },
    ]);
  });
});

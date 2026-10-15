import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDeleteMcpConnectionHandler } from "@/api/handlers/mcp-connectors/delete-connection";
import type { DeleteMcpConnectionDependencies } from "@/api/handlers/mcp-connectors/delete-connection";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const connectorId = toSafeId<"mcpConnector">("connector_1");
const connectionId = toSafeId<"mcpUserConnection">("connection_1");

const loadedConnection: LoadedMcpConnection = {
  type: "bearer",
  responseDisposition: "normal",
  allowedTools: null,
  connectorId,
  description: "",
  displayName: "Registry",
  slug: "registry",
  url: "https://mcp.example.com/mcp",
  userConnectionId: connectionId,
  staticTokenEncrypted: Buffer.from("static"),
  staticTokenIv: Buffer.from("iv"),
};

const setup = ({
  deletedRows,
  loaded = loadedConnection,
  revoke,
}: {
  deletedRows: unknown[];
  loaded?: LoadedMcpConnection | null;
  revoke: DeleteMcpConnectionDependencies["revokeMcpConnectionTokens"];
}) => {
  const events: string[] = [];
  const revocations: unknown[] = [];
  const handler = createDeleteMcpConnectionHandler({
    loadMcpConnectionById: async () => {
      events.push("load");
      return await Promise.resolve(loaded);
    },
    revokeMcpConnectionTokens: async (input) => {
      events.push("revoke");
      revocations.push(input.connection);
      return await revoke(input);
    },
  });
  const chain: Record<string, unknown> = {};
  chain["delete"] = () => chain;
  chain["where"] = () => chain;
  chain["returning"] = async () => {
    events.push("delete");
    return await Promise.resolve(deletedRows);
  };
  type Context = Parameters<typeof handler.handler>[0];
  const context = asTestRaw<Context>({
    params: { connectionId },
    safeDb: async (operation: (tx: unknown) => Promise<unknown>) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    memberRole: sessionMemberRole("member"),
    recordAuditEvent: async () => {
      events.push("audit");
      await Promise.resolve();
    },
    request: new Request(
      `https://api.example.test/v1/mcp/connections/${connectionId}`,
      { method: "DELETE" },
    ),
    route: "/v1/mcp/connections/:connectionId",
  });
  return { context, events, handler, revocations };
};

describe("disconnect with upstream revocation", () => {
  test("revokes the deleted connection's tokens after the local delete", async () => {
    const fixture = setup({
      deletedRows: [{ id: connectionId, connectorId }],
      revoke: async () =>
        await Promise.resolve({
          type: "attempted",
          revoked: ["access_token"],
          failed: [],
        }),
    });

    expect(await fixture.handler.handler(fixture.context)).toEqual({
      id: connectionId,
    });
    await Promise.resolve();

    expect(fixture.events).toEqual(["load", "delete", "audit", "revoke"]);
    expect(fixture.revocations).toEqual([loadedConnection]);
  });

  test("a provider that fails or never answers does not fail the disconnect", async () => {
    for (const revoke of [
      async () => await Promise.reject(new Error("provider down")),
      async () => await new Promise<never>(() => {}),
    ] satisfies DeleteMcpConnectionDependencies["revokeMcpConnectionTokens"][]) {
      const fixture = setup({
        deletedRows: [{ id: connectionId, connectorId }],
        revoke,
      });

      expect(await fixture.handler.handler(fixture.context)).toEqual({
        id: connectionId,
      });
    }
  });

  test("nothing is revoked when no row was deleted or no credentials were loaded", async () => {
    const missing = setup({
      deletedRows: [],
      revoke: async () =>
        await Promise.reject(new Error("must not revoke a kept connection")),
    });
    expect(await missing.handler.handler(missing.context)).toMatchObject({
      code: 404,
    });
    expect(missing.revocations).toEqual([]);

    const unloaded = setup({
      deletedRows: [{ id: connectionId, connectorId }],
      loaded: null,
      revoke: async () =>
        await Promise.reject(new Error("must not revoke without credentials")),
    });
    expect(await unloaded.handler.handler(unloaded.context)).toEqual({
      id: connectionId,
    });
    expect(unloaded.revocations).toEqual([]);
  });
});

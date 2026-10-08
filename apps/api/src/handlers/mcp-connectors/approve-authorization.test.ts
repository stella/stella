import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createApproveMcpAuthorizationHandler } from "@/api/handlers/mcp-connectors/approve-authorization";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const issuer = "https://authorization.example.test";
const connectorUrl = "https://connector.example.test/mcp";
type ApprovalSetupOptions = {
  organizationId: string | null;
  role?: "owner" | "admin" | "member";
  observedIssuer?: string;
  changedDuringDiscovery?: boolean;
};
const setup = ({
  organizationId,
  role = "admin",
  observedIssuer = issuer,
  changedDuringDiscovery = false,
}: ApprovalSetupOptions) => {
  const saved: unknown[] = [];
  const audits: unknown[] = [];
  let discovered = 0;
  const handler = createApproveMcpAuthorizationHandler(
    async ({ rawMcpUrl }) => {
      expect(rawMcpUrl).toBe(connectorUrl);
      discovered += 1;
      return Result.ok({
        protectedResource: {
          resource: connectorUrl,
          authorization_servers: [issuer],
        },
        authorizationServer: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        },
      });
    },
  );
  const connector = {
    id: toSafeId<"mcpConnector">("connector_1"),
    organizationId,
    url: connectorUrl,
    observedIssuer,
    observedEndpointOrigins: [issuer],
    reviewVersion: "2026-10-03 12:46:00.123456+00",
  };
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [connector],
    update: () => ({
      set: (value: unknown) => ({
        where: () => ({
          returning: async () => {
            if (changedDuringDiscovery) {
              return [];
            }
            saved.push(value);
            return [{ connectorId: connector.id }];
          },
        }),
      }),
    }),
  };
  type Context = Parameters<typeof handler.handler>[0];
  const context = asTestRaw<Context>({
    params: { slug: "example" },
    body: { confirmedIssuer: issuer, confirmedEndpointOrigins: [issuer] },
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole(role),
    recordAuditEvent: async (_tx: unknown, value: unknown) => {
      audits.push(value);
    },
    request: new Request(
      "https://api.example.test/v1/mcp/connectors/example/approve-authorization",
      { method: "POST" },
    ),
    route: "/v1/mcp/connectors/:slug/approve-authorization",
  });
  return { handler, context, saved, audits, discovered: () => discovered };
};
test("administrators approve current authorization for shared and custom connectors", async () => {
  for (const organizationId of [null, "org_1"]) {
    for (const role of ["admin", "owner"] as const) {
      const fixture = setup({ organizationId, role });
      expect(await fixture.handler.handler(fixture.context)).toEqual({
        approved: true,
      });
      expect(fixture.saved).toEqual([
        expect.objectContaining({ approvedIssuer: issuer, status: "approved" }),
      ]);
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          metadata: {
            field: "mcpConnectorAuthorization",
            connectorId: "connector_1",
            slug: "example",
          },
        }),
      ]);
      expect(fixture.discovered()).toBe(1);
    }
  }
});
test("authorization approval requires settings permission", async () => {
  const fixture = setup({ organizationId: null, role: "member" });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 403,
  });
  expect(fixture.discovered()).toBe(0);
  expect(fixture.saved).toEqual([]);
  expect(fixture.audits).toEqual([]);
});
test("authorization approval uses the current review version", async () => {
  for (const options of [
    { observedIssuer: `${issuer}/current` },
    { changedDuringDiscovery: true },
  ]) {
    const fixture = setup({ organizationId: null, ...options });
    expect(await fixture.handler.handler(fixture.context)).toMatchObject({
      code: 409,
    });
    expect(fixture.saved).toEqual([]);
    expect(fixture.audits).toEqual([]);
  }
});

test("authorization approval confirms the displayed endpoint origins", async () => {
  const fixture = setup({ organizationId: null });
  fixture.context.body.confirmedEndpointOrigins = [
    "https://different.example.test",
  ];
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.saved).toEqual([]);
  expect(fixture.audits).toEqual([]);
});

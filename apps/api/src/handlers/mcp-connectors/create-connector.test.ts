import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createMcpConnectorHandler } from "@/api/handlers/mcp-connectors/create-connector";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type CreationSetupOptions = {
  issuer: string;
  endpointOrigins?: string[];
  confirmedIssuer?: string | undefined;
  confirmedEndpointOrigins?: string[];
};
const setup = ({
  issuer,
  endpointOrigins = [new URL(issuer).origin],
  confirmedIssuer,
  confirmedEndpointOrigins,
}: CreationSetupOptions) => {
  const inserted: unknown[] = [];
  const audits: unknown[] = [];
  const handler = createMcpConnectorHandler({
    probeServer: async () =>
      Result.ok({
        authType: "oauth2",
        authorizationServerUrl: issuer,
        resourceUrl: "https://connector.example.com/mcp",
        scopes: [],
        endpointOrigins,
        endpointOriginsRequiringConfirmation: endpointOrigins.filter(
          (origin) => origin !== new URL(issuer).origin,
        ),
      }),
    discoverIconUrl: async () => null,
  });
  type Context = Parameters<typeof handler.handler>[0];
  let countQuery = false;
  const chain = {
    select: (fields: Record<string, unknown>) => {
      countQuery = "total" in fields;
      return chain;
    },
    selectDistinct: () => {
      countQuery = false;
      return chain;
    },
    from: () => chain,
    where: () => (countQuery ? Promise.resolve([{ total: 0 }]) : chain),
    limit: async () => [],
    insert: () => ({
      values: (value: unknown) => ({
        returning: async () => {
          inserted.push(value);
          return [{ id: "connector_1", slug: "example", authType: "oauth2" }];
        },
      }),
    }),
  };
  const context = asTestRaw<Context>({
    body: {
      url: "https://connector.example.com/mcp",
      displayName: "Example",
      confirmedIssuer,
      confirmedEndpointOrigins,
    },
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole("admin"),
    recordAuditEvent: async (_tx: unknown, value: unknown) => {
      audits.push(value);
    },
    request: new Request("https://api.example.test/v1/mcp/connectors", {
      method: "POST",
    }),
    route: "/v1/mcp/connectors",
  });
  return { handler, context, inserted, audits };
};

test("connector creation requests confirmation for external authorization", async () => {
  const issuer = "https://authorization.example.net";
  for (const confirmation of [undefined, "https://authorization.example.org"]) {
    const fixture = setup({
      issuer,
      confirmedIssuer: confirmation,
      confirmedEndpointOrigins: [issuer],
    });
    expect(await fixture.handler.handler(fixture.context)).toEqual({
      type: "confirmation_required",
      issuer,
      endpointOrigins: [issuer],
    });
    expect(fixture.inserted).toEqual([]);
    expect(fixture.audits).toEqual([]);
  }
});

test("connector creation stores the confirmed current authorization", async () => {
  const issuer = "https://authorization.example.net";
  const endpointOrigins = [issuer, "https://tokens.example.org"];
  const fixture = setup({
    issuer,
    endpointOrigins,
    confirmedIssuer: issuer,
    confirmedEndpointOrigins: endpointOrigins,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "created",
  });
  expect(fixture.inserted).toEqual([
    expect.objectContaining({
      oauthIssuer: issuer,
      oauthConfirmedEndpointOrigins: endpointOrigins,
    }),
  ]);
  expect(fixture.audits).toHaveLength(1);
});

test("connector creation confirms exact endpoint origins", async () => {
  const issuer = "https://authorization.example.com";
  const fixture = setup({
    issuer,
    endpointOrigins: [issuer, "https://tokens.example.org"],
    confirmedIssuer: issuer,
    confirmedEndpointOrigins: [issuer, "https://other.example.org"],
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "confirmation_required",
  });
  expect(fixture.inserted).toEqual([]);
});

test("connector creation accepts authorization within its domain", async () => {
  const fixture = setup({ issuer: "https://authorization.example.com" });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "created",
  });
  expect(fixture.inserted).toEqual([
    expect.objectContaining({
      oauthIssuer: "https://authorization.example.com",
      oauthConfirmedEndpointOrigins: null,
    }),
  ]);
});

import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  mcpOAuthState,
  mcpUserConnections,
  mcpConnectorAuthorizationReviews,
} from "@/api/db/schema";
import { createConnectMcpConnectorHandler } from "@/api/handlers/mcp-connectors/connect";
import { toSafeId } from "@/api/lib/branded-types";
import { bindDiscoveredMetadata } from "@/api/lib/mcp-upstream/oauth";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const connectorUrl = "https://mcp.example.com/rpc";
const issuer = "https://as.example.com";

const metadata = () =>
  bindDiscoveredMetadata({
    connectorUrl,
    protectedResource: {
      resource: connectorUrl,
      authorization_servers: [issuer],
    },
    authorizationServer: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      client_id_metadata_document_supported: true,
    },
  });

const connector = (oauthIssuer: string | null) => ({
  id: toSafeId<"mcpConnector">("connector_1"),
  slug: "example",
  url: connectorUrl,
  authType: "oauth2",
  oauthIssuer,
  oauthRequestedScopes: [],
});

const setup = (oauthIssuer: string | null) => {
  const states: unknown[] = [];
  const reviews: { table: unknown; value: unknown }[] = [];
  let clientReads = 0;
  const handler = createConnectMcpConnectorHandler(async () => metadata());
  type Context = Parameters<typeof handler.handler>[0];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [connector(oauthIssuer)],
    insert: (table: unknown) =>
      table === mcpOAuthState
        ? {
            values: async (value: unknown) => {
              states.push(value);
            },
          }
        : {
            values: (value: unknown) => ({
              onConflictDoUpdate: async () => {
                reviews.push({ table, value });
              },
            }),
          },
    query: {
      mcpOAuthClients: {
        findFirst: async () => {
          clientReads += 1;
          return {
            clientId: "client",
            clientSecretEncrypted: null,
            clientSecretIv: null,
          };
        },
      },
    },
  };
  const context = asTestRaw<Context>({
    params: { slug: "example" },
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole("owner"),
    request: new Request(
      "https://api.example.com/v1/mcp/connectors/example/connect",
    ),
    route: "/v1/mcp/connectors/:slug/connect",
  });
  return { context, handler, states, reviews, clientReads: () => clientReads };
};

test("requires current connector approval before connecting", async () => {
  const setupResult = setup(`${issuer}/other`);
  const result = await setupResult.handler.handler(setupResult.context);
  expect(result).toMatchObject({
    code: 409,
    response: { code: "mcp_authorization_approval_required" },
  });
  expect(setupResult.clientReads()).toBe(0);
  expect(setupResult.states).toEqual([]);
  expect(
    setupResult.reviews.find(({ table }) => table === mcpUserConnections)
      ?.value,
  ).toMatchObject({ status: "needs_approval" });
  expect(
    setupResult.reviews.find(
      ({ table }) => table === mcpConnectorAuthorizationReviews,
    )?.value,
  ).toMatchObject({ observedIssuer: issuer });
});

test("connects using configured connector metadata", async () => {
  for (const approvedIssuer of [null, issuer]) {
    const setupResult = setup(approvedIssuer);
    const result = await setupResult.handler.handler(setupResult.context);
    expect(result).toMatchObject({ type: "oauth2" });
    expect(setupResult.states).toHaveLength(1);
    expect(setupResult.states.at(0)).toMatchObject({
      resourceUrl: connectorUrl,
      authorizationServerUrl: issuer,
    });
    if ("type" in result && result.type === "oauth2") {
      const url = new URL(result.authorizeUrl);
      expect(url.origin).toBe(issuer);
      expect(url.searchParams.get("resource")).toBe(connectorUrl);
    }
  }
});

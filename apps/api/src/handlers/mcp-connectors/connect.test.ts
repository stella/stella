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

const metadata = (authorizationIssuer = issuer) =>
  bindDiscoveredMetadata({
    connectorUrl,
    protectedResource: {
      resource: connectorUrl,
      authorization_servers: [authorizationIssuer],
    },
    authorizationServer: {
      issuer: authorizationIssuer,
      authorization_endpoint: `${authorizationIssuer}/authorize`,
      token_endpoint: `${authorizationIssuer}/token`,
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

const setup = (
  oauthIssuer: string | null,
  review?: {
    approvedIssuer: string | null;
    status: "approved" | "needs_reapproval";
  },
) => {
  const states: unknown[] = [];
  const reviews: { table: unknown; value: unknown }[] = [];
  let clientReads = 0;
  const audits: unknown[] = [];
  let pinnedReview = review;
  let currentIssuer = issuer;
  const handler = createConnectMcpConnectorHandler(async () =>
    metadata(currentIssuer),
  );
  type Context = Parameters<typeof handler.handler>[0];
  const chain = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => [
      {
        ...connector(oauthIssuer),
        orgApprovedIssuer: pinnedReview?.approvedIssuer ?? null,
        authorizationReviewStatus: pinnedReview?.status ?? null,
      },
    ],
    insert: (table: unknown) =>
      table === mcpOAuthState
        ? {
            values: async (value: unknown) => {
              states.push(value);
            },
          }
        : {
            values: (value: unknown) => ({
              onConflictDoNothing: () => ({
                returning: async () => {
                  pinnedReview = { approvedIssuer: issuer, status: "approved" };
                  reviews.push({ table, value });
                  return [{ connectorId: "connector_1" }];
                },
              }),
              onConflictDoUpdate: async () => {
                reviews.push({ table, value });
              },
            }),
          },
    query: {
      mcpConnectorAuthorizationReviews: { findFirst: async () => pinnedReview },
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
    recordAuditEvent: async (_tx: unknown, value: unknown) => {
      audits.push(value);
    },
    request: new Request(
      "https://api.example.com/v1/mcp/connectors/example/connect",
    ),
    route: "/v1/mcp/connectors/:slug/connect",
  });
  return {
    context,
    handler,
    states,
    reviews,
    audits,
    setDiscoveredIssuer: (value: string) => {
      currentIssuer = value;
    },
    clientReads: () => clientReads,
  };
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

test("members connect with organization-approved authorization", async () => {
  const fixture = setup(`${issuer}/previous`, {
    approvedIssuer: issuer,
    status: "approved",
  });
  fixture.context.memberRole = sessionMemberRole("member");
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "oauth2",
  });
  expect(fixture.states).toHaveLength(1);
});

test("pending authorization requires administrator approval", async () => {
  const fixture = setup(issuer, {
    approvedIssuer: issuer,
    status: "needs_reapproval",
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.states).toEqual([]);
});

test("first connection retains its observed authorization configuration", async () => {
  const fixture = setup(null);
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "oauth2",
  });
  expect(
    fixture.reviews.find(
      ({ table }) => table === mcpConnectorAuthorizationReviews,
    )?.value,
  ).toMatchObject({
    approvedIssuer: issuer,
    observedIssuer: issuer,
    status: "approved",
  });
  expect(fixture.audits).toHaveLength(1);
});

test("first connection approval persists for subsequent connections", async () => {
  const fixture = setup(null);
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    type: "oauth2",
  });
  fixture.setDiscoveredIssuer("https://as.example.net");
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.states).toHaveLength(1);
  expect(fixture.reviews.at(-1)?.value).toMatchObject({
    observedIssuer: "https://as.example.net",
  });
});

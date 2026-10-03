import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import listMcpConnectors from "@/api/handlers/mcp-connectors/list-connectors";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type Context = Parameters<typeof listMcpConnectors.handler>[0];

const connectors = [
  {
    id: toSafeId<"mcpConnector">("connector_oauth_reviewed"),
    slug: "oauth-reviewed",
    organizationId: null,
    displayName: "OAuth reviewed",
    description: "",
    url: "https://reviewed.example.test/mcp",
    authType: "oauth2",
    isCurated: true,
    oauthRequestedScopes: [],
    allowedTools: [],
    documentationUrl: null,
    tokenHelpUrl: null,
    iconUrl: null,
    oauthIssuer: null,
    oauthConfirmedEndpointOrigins: null,
    reviewApprovedIssuer: null,
    reviewApprovedEndpointOrigins: null,
    reviewObservedIssuer: "https://authorization.example.test",
    reviewEndpointOrigins: ["https://authorization.example.test"],
    authorizationReviewExists: true,
  },
  {
    id: toSafeId<"mcpConnector">("connector_oauth_approved"),
    slug: "oauth-approved",
    organizationId: null,
    displayName: "OAuth approved",
    description: "",
    url: "https://approved.example.test/mcp",
    authType: "oauth2",
    isCurated: true,
    oauthRequestedScopes: [],
    allowedTools: [],
    documentationUrl: null,
    tokenHelpUrl: null,
    iconUrl: null,
    oauthIssuer: "https://authorization.example.test",
    oauthConfirmedEndpointOrigins: null,
    reviewApprovedIssuer: null,
    reviewApprovedEndpointOrigins: null,
    reviewObservedIssuer: null,
    reviewEndpointOrigins: null,
    authorizationReviewExists: false,
  },
  {
    id: toSafeId<"mcpConnector">("connector_oauth_unconfigured"),
    slug: "oauth-unconfigured",
    organizationId: null,
    displayName: "OAuth unconfigured",
    description: "",
    url: "https://unconfigured.example.test/mcp",
    authType: "oauth2",
    isCurated: false,
    oauthRequestedScopes: [],
    allowedTools: [],
    documentationUrl: null,
    tokenHelpUrl: null,
    iconUrl: null,
    oauthIssuer: null,
    oauthConfirmedEndpointOrigins: null,
    reviewApprovedIssuer: null,
    reviewApprovedEndpointOrigins: null,
    reviewObservedIssuer: null,
    reviewEndpointOrigins: null,
    authorizationReviewExists: false,
  },
  {
    id: toSafeId<"mcpConnector">("connector_bearer"),
    slug: "bearer",
    organizationId: null,
    displayName: "Bearer",
    description: "",
    url: "https://bearer.example.test/mcp",
    authType: "bearer",
    isCurated: false,
    oauthRequestedScopes: [],
    allowedTools: [],
    documentationUrl: null,
    tokenHelpUrl: null,
    iconUrl: null,
    oauthIssuer: null,
    oauthConfirmedEndpointOrigins: null,
    reviewApprovedIssuer: null,
    reviewApprovedEndpointOrigins: null,
    reviewObservedIssuer: "https://authorization.example.test",
    reviewEndpointOrigins: ["https://authorization.example.test"],
    authorizationReviewExists: true,
  },
];

test("lists shared authorization status in one connector query", async () => {
  let connectorListExecutions = 0;
  let databaseOperations = 0;
  let settingsQueries = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      connectorListExecutions += 1;
      return connectors;
    },
    query: {
      organizationSettings: {
        findFirst: async () => {
          settingsQueries += 1;
          return undefined;
        },
      },
    },
  };
  const context = asTestRaw<Context>({
    safeDb: async (operation: (tx: unknown) => unknown) => {
      databaseOperations += 1;
      return Result.ok(await operation(chain));
    },
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    memberRole: sessionMemberRole("owner"),
  });

  const result = await listMcpConnectors.handler(context);
  if (!("connectors" in result)) {
    panic("Expected a connector list response");
  }

  expect(
    result.connectors.map(({ slug, authorizationStatus }) => [
      slug,
      authorizationStatus,
    ]),
  ).toEqual([
    ["oauth-reviewed", "needs_reapproval"],
    ["oauth-approved", "approved"],
    ["oauth-unconfigured", "unconfigured"],
    ["bearer", "not_required"],
  ]);
  expect(connectorListExecutions).toBe(1);
  expect(databaseOperations).toBe(2);
  expect(settingsQueries).toBe(1);
});

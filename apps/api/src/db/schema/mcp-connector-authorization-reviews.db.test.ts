import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpOAuthClients,
  mcpUserConnections,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createApproveMcpAuthorizationHandler } from "@/api/handlers/mcp-connectors/approve-authorization";
import { createConnectMcpConnectorHandler } from "@/api/handlers/mcp-connectors/connect";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { recordMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import {
  claimMcpRefreshLease,
  createMcpClientForConnection,
  loadActiveMcpConnectionsForUser,
  loadMcpConnectionById,
  releaseMcpRefreshLease,
} from "@/api/lib/mcp-upstream/connections";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { TABLE_POLICY_SETTINGS_BASELINE } from "@/api/tests/security/table-policy-settings-baseline";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const ownerId = mintAuthProviderId<"user">();
const memberId = mintAuthProviderId<"user">();
const connectorId = createSafeId<"mcpConnector">();
const connectionId = createSafeId<"mcpUserConnection">();
const otherOrganizationId = mintAuthProviderId<"organization">();
const catalogueConnectorId = createSafeId<"mcpConnector">();
const outboundPermit = grantThirdPartyOutboundPermit();

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
  // Apply the committed definition, including settings schema push cannot represent.
  await testDb.execute(sql`DROP TABLE mcp_connector_authorization_reviews`);
  await testDb.execute(
    sql`ALTER TABLE mcp_connectors DROP COLUMN oauth_confirmed_endpoint_origins`,
  );
  await testDb.execute(
    sql`ALTER TABLE mcp_user_connections DROP COLUMN refresh_lease_expires_at, DROP COLUMN refresh_retry_after`,
  );
  const migration = readFileSync(
    new URL(
      "../../../drizzle/20261003124600_mcp_authorization_reviews/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    await testDb.execute(sql.raw(statement));
  }
  await testDb.insert(user).values([
    {
      id: ownerId,
      name: "Connector owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: memberId,
      name: "Connector member",
      email: `${memberId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Connector organization",
    slug: `connector-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values([
    {
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: memberId,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(mcpConnectors).values({
    id: connectorId,
    slug: `review-${connectorId}`,
    organizationId,
    displayName: "Review connector",
    description: "",
    url: "https://mcp.example.test",
    authType: "oauth2",
  });
  await testDb.insert(mcpConnectorAuthorizationReviews).values({
    organizationId,
    connectorId,
    observedIssuer: "https://auth.example.test",
  });
  await testDb.insert(mcpUserConnections).values({
    id: connectionId,
    organizationId,
    connectorId,
    userId: ownerId,
    status: "connected",
  });
});

afterAll(async () => {
  await testDb
    .delete(mcpConnectors)
    .where(eq(mcpConnectors.id, catalogueConnectorId));
  await testDb
    .delete(organization)
    .where(eq(organization.id, otherOrganizationId));
  await testDb.delete(organization).where(eq(organization.id, organizationId));
  await testDb.delete(user).where(eq(user.id, ownerId));
  await testDb.delete(user).where(eq(user.id, memberId));
  await releaseTestDb();
});

type DiscoveredIssuerMetadataOptions = {
  connectorUrl: string;
  issuer: string;
};

const discoveredIssuerMetadata = ({
  connectorUrl,
  issuer,
}: DiscoveredIssuerMetadataOptions) =>
  Result.ok({
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

type ApprovalRequestOptions = {
  slug: string;
  discoveredIssuer: string;
  confirmedIssuer: string;
  activeOrganizationId: SafeId<"organization">;
};

const approveAuthorization = async ({
  slug,
  discoveredIssuer,
  confirmedIssuer,
  activeOrganizationId,
}: ApprovalRequestOptions) => {
  const approval = createApproveMcpAuthorizationHandler(async (connectorUrl) =>
    discoveredIssuerMetadata({ connectorUrl, issuer: discoveredIssuer }),
  );
  return await approval.handler(
    asTestRaw<Parameters<typeof approval.handler>[0]>({
      params: { slug },
      body: {
        confirmedIssuer,
        confirmedEndpointOrigins: [new URL(confirmedIssuer).origin],
      },
      safeDb: createSafeDb(testDb, [], activeOrganizationId, ownerId),
      session: { activeOrganizationId },
      user: { id: ownerId },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
      request: new Request(
        `https://api.example.test/v1/mcp/connectors/${slug}/approve-authorization`,
        { method: "POST" },
      ),
      route: "/v1/mcp/connectors/:slug/approve-authorization",
    }),
  );
};

type MemberConnectOptions = {
  slug: string;
  issuer: string;
  curatedApproval?: { issuer: string; endpointOrigins: string[] };
  audits?: unknown[];
};

const connectAsMember = async ({
  slug,
  issuer,
  curatedApproval,
  audits = [],
}: MemberConnectOptions) => {
  const connect = createConnectMcpConnectorHandler({
    discoverMetadata: async (connectorUrl) =>
      discoveredIssuerMetadata({ connectorUrl, issuer }),
    curatedOAuthApproval: () => curatedApproval ?? null,
  });
  return await connect.handler(
    asTestRaw<Parameters<typeof connect.handler>[0]>({
      params: { slug },
      safeDb: createSafeDb(testDb, [], organizationId, memberId),
      session: { activeOrganizationId: organizationId },
      user: { id: memberId },
      memberRole: sessionMemberRole("member"),
      recordAuditEvent: async (_tx: unknown, event: unknown) => {
        audits.push(event);
      },
      request: new Request(
        `https://api.example.test/v1/mcp/connectors/${slug}/connect`,
      ),
      route: "/v1/mcp/connectors/:slug/connect",
    }),
  );
};

const reviewRows = async (reviewedConnectorId: SafeId<"mcpConnector">) =>
  await testDb
    .select()
    .from(mcpConnectorAuthorizationReviews)
    .where(
      eq(mcpConnectorAuthorizationReviews.connectorId, reviewedConnectorId),
    )
    .orderBy(mcpConnectorAuthorizationReviews.organizationId);

describe("MCP connector authorization reviews", () => {
  test("the migrated table matches its declared row policy settings", async () => {
    const settings = await testDb.execute<{
      enabled: boolean;
      forced: boolean;
    }>(sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_catalog.pg_class
      WHERE oid = 'public.mcp_connector_authorization_reviews'::regclass
    `);
    expect(settings.rows).toEqual([{ enabled: true, forced: true }]);
    expect(TABLE_POLICY_SETTINGS_BASELINE).not.toContain(
      "mcp_connector_authorization_reviews",
    );
    const declared = getTableConfig(mcpConnectorAuthorizationReviews);
    expect(declared.enableRLS).toBe(true);
  });

  test("the migrated update policy matches its declared check", async () => {
    const declared = getTableConfig(mcpConnectorAuthorizationReviews);
    const update = declared.policies.find((policy) => policy.for === "update");
    expect(update?.using).toBeDefined();
    expect(update?.withCheck).toBeDefined();
    const dialect = new PgDialect();
    if (!update?.using || !update.withCheck) {
      return;
    }
    expect(dialect.sqlToQuery(update.withCheck).sql).toBe(
      dialect.sqlToQuery(update.using).sql,
    );
    const policies = await testDb.execute<{
      using_expression: string;
      check_expression: string;
    }>(sql`
      SELECT qual AS using_expression, with_check AS check_expression
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'mcp_connector_authorization_reviews'
        AND policyname = 'organization_update'
    `);
    expect(policies.rows).toHaveLength(1);
    const policy = policies.rows.at(0);
    expect(policy?.check_expression).toBeString();
    expect(policy?.check_expression).toBe(policy?.using_expression);
    expect(policy?.check_expression).toContain("organization_id");
    expect(policy?.check_expression).toContain("app.organization_id");
  });

  test("keeps the organization review visible to its members", async () => {
    const scopedQuery = createScopedQuery(testDb);
    const rows = await scopedQuery(
      [],
      organizationId,
      (tx) =>
        tx
          .select({
            observedIssuer: mcpConnectorAuthorizationReviews.observedIssuer,
          })
          .from(mcpConnectorAuthorizationReviews)
          .where(eq(mcpConnectorAuthorizationReviews.connectorId, connectorId)),
      memberId,
    );

    expect(rows).toEqual([{ observedIssuer: "https://auth.example.test" }]);
  });

  test("applies organization authorization state to every member connection", async () => {
    const sharedConnectorId = createSafeId<"mcpConnector">();
    const memberConnectionId = createSafeId<"mcpUserConnection">();
    const connections = [
      { id: createSafeId<"mcpUserConnection">(), userId: ownerId },
      { id: memberConnectionId, userId: memberId },
    ];
    await testDb.insert(mcpConnectors).values({
      id: sharedConnectorId,
      organizationId,
      slug: `shared-${sharedConnectorId}`,
      displayName: "Shared connector",
      description: "",
      url: "https://mcp.example.test/shared",
      authType: "oauth2",
      oauthIssuer: "https://auth.example.test/shared",
    });
    await testDb.insert(mcpOAuthClients).values({
      organizationId,
      connectorId: sharedConnectorId,
      authorizationServerUrl: "https://auth.example.test/shared",
      clientId: "shared-client",
      registrationResponse: {},
    });
    await testDb.insert(mcpUserConnections).values(
      connections.map((connection) => ({
        ...connection,
        organizationId,
        connectorId: sharedConnectorId,
        status: "connected" as const,
        accessTokenEncrypted: Buffer.from("token"),
        accessTokenIv: Buffer.from("iv"),
        resourceUrl: "https://mcp.example.test/shared",
        authorizationServerUrl: "https://auth.example.test/shared",
      })),
    );
    let connectionReads = 0;
    const measuredDb = withQueryLogger(testDb, {
      logQuery: (query) => {
        if (
          query.startsWith("select ") &&
          query.includes('from "mcp_user_connections"')
        ) {
          connectionReads += 1;
        }
      },
    });
    for (const connection of connections) {
      const safeDb = asTestRaw<SafeDb>(
        createSafeDb(measuredDb, [], organizationId, connection.userId),
      );
      connectionReads = 0;
      expect(
        await loadMcpConnectionById({
          connectionId: connection.id,
          organizationId,
          safeDb,
          userId: connection.userId,
        }),
      ).not.toBeNull();
      expect(connectionReads).toBe(1);
    }
    Result.unwrap(
      await recordMcpAuthorizationReview({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], organizationId, ownerId),
        ),
        organizationId,
        userId: ownerId,
        connectorId: sharedConnectorId,
        connection: { type: "mark" },
        recordAuditEvent: async () => {},
        observedIssuer: "https://auth.example.test/shared",
        observedEndpointOrigins: ["https://auth.example.test"],
      }),
    );
    for (const connection of connections) {
      const safeDb = asTestRaw<SafeDb>(
        createSafeDb(measuredDb, [], organizationId, connection.userId),
      );
      connectionReads = 0;
      expect(
        await loadMcpConnectionById({
          connectionId: connection.id,
          organizationId,
          safeDb,
          userId: connection.userId,
        }),
      ).toBeNull();
      expect(connectionReads).toBe(1);
      connectionReads = 0;
      expect(
        await loadActiveMcpConnectionsForUser({
          organizationId,
          safeDb,
          userId: connection.userId,
        }),
      ).toEqual([]);
      expect(connectionReads).toBe(1);
    }
    await testDb
      .update(mcpConnectorAuthorizationReviews)
      .set({
        updatedAt: sql`'2026-10-03 12:46:00.123456+00'::timestamptz`,
      })
      .where(
        eq(mcpConnectorAuthorizationReviews.connectorId, sharedConnectorId),
      );
    const audits: unknown[] = [];
    const approval = createApproveMcpAuthorizationHandler(
      async (connectorUrl) =>
        Result.ok({
          protectedResource: {
            resource: connectorUrl,
            authorization_servers: ["https://auth.example.test/shared"],
          },
          authorizationServer: {
            issuer: "https://auth.example.test/shared",
            authorization_endpoint:
              "https://auth.example.test/shared/authorize",
            token_endpoint: "https://auth.example.test/shared/token",
          },
        }),
    );
    const approvalContext = asTestRaw<Parameters<typeof approval.handler>[0]>({
      params: { slug: `shared-${sharedConnectorId}` },
      body: {
        confirmedIssuer: "https://auth.example.test/shared",
        confirmedEndpointOrigins: ["https://auth.example.test"],
      },
      safeDb: createSafeDb(testDb, [], organizationId, ownerId),
      session: { activeOrganizationId: organizationId },
      user: { id: ownerId },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async (_tx: unknown, event: unknown) => {
        audits.push(event);
      },
      request: new Request(
        "https://api.example.test/v1/mcp/connectors/shared/approve-authorization",
        { method: "POST" },
      ),
      route: "/v1/mcp/connectors/:slug/approve-authorization",
    });
    expect(await approval.handler(approvalContext)).toEqual({ approved: true });
    expect(audits).toHaveLength(1);
    await testDb
      .update(mcpConnectors)
      .set({
        oauthIssuer: "https://auth.example.test/configured",
      })
      .where(eq(mcpConnectors.id, sharedConnectorId));
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [], organizationId, memberId),
    );
    expect(
      await loadMcpConnectionById({
        connectionId: memberConnectionId,
        organizationId,
        safeDb,
        userId: memberId,
      }),
    ).not.toBeNull();
    expect(
      (
        await loadActiveMcpConnectionsForUser({
          organizationId,
          safeDb,
          userId: memberId,
        })
      ).map((connection) => connection.userConnectionId),
    ).toEqual([memberConnectionId]);
    await testDb.insert(mcpOAuthClients).values({
      organizationId,
      connectorId: sharedConnectorId,
      authorizationServerUrl: "https://auth.example.test/previous",
      clientId: "previous-client",
      registrationResponse: {},
    });
    await testDb
      .update(mcpUserConnections)
      .set({
        authorizationServerUrl: "https://auth.example.test/previous",
      })
      .where(eq(mcpUserConnections.id, memberConnectionId));
    const previousConnection = await loadMcpConnectionById({
      connectionId: memberConnectionId,
      organizationId,
      safeDb,
      userId: memberId,
    });
    expect(previousConnection).not.toBeNull();
    if (!previousConnection) {
      return;
    }
    expect(
      await createMcpClientForConnection({
        organizationId,
        permit: outboundPermit,
        row: previousConnection,
        safeDb,
        userId: memberId,
      }),
    ).toBeNull();
    expect(
      await testDb
        .select({
          status: mcpUserConnections.status,
          refreshLeaseExpiresAt: mcpUserConnections.refreshLeaseExpiresAt,
        })
        .from(mcpUserConnections)
        .where(eq(mcpUserConnections.id, memberConnectionId)),
    ).toEqual([
      {
        status: "needs_approval",
        refreshLeaseExpiresAt: null,
      },
    ]);
    expect(
      await testDb
        .select({
          status: mcpConnectorAuthorizationReviews.status,
          approvedIssuer: mcpConnectorAuthorizationReviews.approvedIssuer,
          approvedEndpointOrigins:
            mcpConnectorAuthorizationReviews.approvedEndpointOrigins,
        })
        .from(mcpConnectorAuthorizationReviews)
        .where(
          eq(mcpConnectorAuthorizationReviews.connectorId, sharedConnectorId),
        ),
    ).toEqual([
      {
        status: "approved",
        approvedIssuer: "https://auth.example.test/shared",
        approvedEndpointOrigins: ["https://auth.example.test"],
      },
    ]);
    Result.unwrap(
      await recordMcpAuthorizationReview({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], organizationId, ownerId),
        ),
        organizationId,
        userId: ownerId,
        connectorId: sharedConnectorId,
        connection: { type: "mark" },
        recordAuditEvent: async () => {},
        observedIssuer: "https://auth.example.test/updated",
        observedEndpointOrigins: [
          "https://auth.example.test",
          "https://token.example.test",
        ],
      }),
    );
    const sharedReview = async () =>
      await testDb
        .select({
          approvedIssuer: mcpConnectorAuthorizationReviews.approvedIssuer,
          approvedEndpointOrigins:
            mcpConnectorAuthorizationReviews.approvedEndpointOrigins,
          status: mcpConnectorAuthorizationReviews.status,
          observedIssuer: mcpConnectorAuthorizationReviews.observedIssuer,
          observedEndpointOrigins:
            mcpConnectorAuthorizationReviews.observedEndpointOrigins,
        })
        .from(mcpConnectorAuthorizationReviews)
        .where(
          eq(mcpConnectorAuthorizationReviews.connectorId, sharedConnectorId),
        );
    const updatedReview = {
      approvedIssuer: "https://auth.example.test/shared",
      approvedEndpointOrigins: ["https://auth.example.test"],
      observedIssuer: "https://auth.example.test/updated",
      observedEndpointOrigins: [
        "https://auth.example.test",
        "https://token.example.test",
      ],
      status: "needs_reapproval" as const,
    };
    expect(await sharedReview()).toEqual([updatedReview]);
    // A later observation without endpoint origins keeps the stored ones.
    Result.unwrap(
      await recordMcpAuthorizationReview({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], organizationId, ownerId),
        ),
        organizationId,
        userId: ownerId,
        connectorId: sharedConnectorId,
        connection: { type: "mark" },
        recordAuditEvent: async () => {},
        observedIssuer: "https://auth.example.test/updated",
      }),
    );
    expect(await sharedReview()).toEqual([updatedReview]);
    expect(
      await loadMcpConnectionById({
        connectionId: memberConnectionId,
        organizationId,
        safeDb,
        userId: memberId,
      }),
    ).toBeNull();
  });

  test("reviews a connector configured without an issuer until an administrator approves it", async () => {
    const legacyConnectorId = createSafeId<"mcpConnector">();
    const legacyConnectionId = createSafeId<"mcpUserConnection">();
    const legacyUrl = "https://mcp.example.test/legacy";
    const legacyIssuer = "https://auth.example.test/legacy";
    await testDb.insert(mcpConnectors).values({
      id: legacyConnectorId,
      organizationId,
      slug: `legacy-${legacyConnectorId}`,
      displayName: "Legacy connector",
      description: "",
      url: legacyUrl,
      authType: "oauth2",
    });
    await testDb.insert(mcpOAuthClients).values({
      organizationId,
      connectorId: legacyConnectorId,
      authorizationServerUrl: legacyIssuer,
      clientId: "legacy-client",
      registrationResponse: {},
    });
    await testDb.insert(mcpUserConnections).values({
      id: legacyConnectionId,
      organizationId,
      connectorId: legacyConnectorId,
      userId: ownerId,
      status: "connected",
      accessTokenEncrypted: Buffer.from("token"),
      accessTokenIv: Buffer.from("iv"),
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      resourceUrl: legacyUrl,
      authorizationServerUrl: legacyIssuer,
    });
    const discoverLegacyMetadata = async (url: string) =>
      Result.ok({
        protectedResource: {
          resource: url,
          authorization_servers: [legacyIssuer],
        },
        authorizationServer: {
          issuer: legacyIssuer,
          authorization_endpoint: `${legacyIssuer}/authorize`,
          token_endpoint: `${legacyIssuer}/token`,
        },
      });
    const authorizationHeaders: (string | undefined)[] = [];
    const dependencies = asTestRaw<
      NonNullable<
        Parameters<typeof createMcpClientForConnection>[0]["dependencies"]
      >
    >({
      discoverOAuthMetadataForApproval: discoverLegacyMetadata,
      decryptMcpSecret: async () => "stored-access-token",
      createMCPClient: async ({
        transport,
      }: {
        transport: { headers?: Record<string, string> };
      }) => {
        authorizationHeaders.push(transport.headers?.["Authorization"]);
        return { close: async () => {} };
      },
    });
    const outboundFetch = asTestRaw<
      NonNullable<
        Parameters<typeof createMcpClientForConnection>[0]["outboundFetch"]
      >
    >({
      validateOutboundFetchTarget: async (url: string) =>
        Result.ok({ addresses: [], url: new URL(url) }),
    });
    const ownerDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [], organizationId, ownerId),
    );
    const connect = async () => {
      const row = await loadMcpConnectionById({
        connectionId: legacyConnectionId,
        organizationId,
        safeDb: ownerDb,
        userId: ownerId,
      });
      return row === null
        ? null
        : await createMcpClientForConnection({
            organizationId,
            permit: outboundPermit,
            row,
            safeDb: ownerDb,
            userId: ownerId,
            dependencies,
            outboundFetch,
          });
    };

    expect(await connect()).toBeNull();
    expect(
      await testDb
        .select({
          status: mcpConnectorAuthorizationReviews.status,
          observedIssuer: mcpConnectorAuthorizationReviews.observedIssuer,
          observedEndpointOrigins:
            mcpConnectorAuthorizationReviews.observedEndpointOrigins,
        })
        .from(mcpConnectorAuthorizationReviews)
        .where(
          eq(mcpConnectorAuthorizationReviews.connectorId, legacyConnectorId),
        ),
    ).toEqual([
      {
        status: "needs_reapproval",
        observedIssuer: legacyIssuer,
        observedEndpointOrigins: ["https://auth.example.test"],
      },
    ]);
    expect(
      await testDb
        .select({ status: mcpUserConnections.status })
        .from(mcpUserConnections)
        .where(eq(mcpUserConnections.id, legacyConnectionId)),
    ).toEqual([{ status: "connected" }]);
    // The pending review keeps the connector's connections from loading.
    expect(await connect()).toBeNull();
    expect(authorizationHeaders).toEqual([]);

    const approval = createApproveMcpAuthorizationHandler(
      discoverLegacyMetadata,
    );
    const approvalContext = asTestRaw<Parameters<typeof approval.handler>[0]>({
      params: { slug: `legacy-${legacyConnectorId}` },
      body: {
        confirmedIssuer: legacyIssuer,
        confirmedEndpointOrigins: ["https://auth.example.test"],
      },
      safeDb: createSafeDb(testDb, [], organizationId, ownerId),
      session: { activeOrganizationId: organizationId },
      user: { id: ownerId },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
      request: new Request(
        "https://api.example.test/v1/mcp/connectors/legacy/approve-authorization",
        { method: "POST" },
      ),
      route: "/v1/mcp/connectors/:slug/approve-authorization",
    });
    expect(await approval.handler(approvalContext)).toEqual({ approved: true });

    expect(await connect()).not.toBeNull();
    expect(authorizationHeaders).toEqual(["Bearer stored-access-token"]);
  });

  test("a member's first connection to a connector without an issuer awaits administrator approval", async () => {
    const unconfiguredConnectorId = createSafeId<"mcpConnector">();
    const slug = `unconfigured-${unconfiguredConnectorId}`;
    const issuer = "https://auth.example.test/unconfigured";
    await testDb.insert(mcpConnectors).values({
      id: unconfiguredConnectorId,
      organizationId,
      slug,
      displayName: "Unconfigured connector",
      description: "",
      url: "https://mcp.example.test/unconfigured",
      authType: "oauth2",
    });
    const audits: unknown[] = [];

    expect(await connectAsMember({ slug, issuer, audits })).toMatchObject({
      code: 409,
      response: { code: "mcp_authorization_approval_required" },
    });
    expect(await reviewRows(unconfiguredConnectorId)).toEqual([
      expect.objectContaining({
        organizationId,
        status: "needs_reapproval",
        observedIssuer: issuer,
        observedEndpointOrigins: ["https://auth.example.test"],
        approvedIssuer: null,
        approvedEndpointOrigins: null,
      }),
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          field: "mcpConnectorAuthorization",
          status: "needs_reapproval",
          observedIssuer: issuer,
        }),
      }),
    ]);
    expect(
      await testDb
        .select({ id: mcpOAuthClients.id })
        .from(mcpOAuthClients)
        .where(eq(mcpOAuthClients.connectorId, unconfiguredConnectorId)),
    ).toEqual([]);

    // A repeated attempt stays pending and records no approval.
    expect(await connectAsMember({ slug, issuer })).toMatchObject({
      code: 409,
    });
    expect(await reviewRows(unconfiguredConnectorId)).toEqual([
      expect.objectContaining({
        status: "needs_reapproval",
        approvedIssuer: null,
      }),
    ]);

    expect(
      await approveAuthorization({
        slug,
        discoveredIssuer: issuer,
        confirmedIssuer: issuer,
        activeOrganizationId: organizationId,
      }),
    ).toEqual({ approved: true });
    expect(await connectAsMember({ slug, issuer })).toMatchObject({
      type: "oauth2",
    });
  });

  test("a curated connector connects with its catalogue issuer without a review", async () => {
    const curatedConnectorId = createSafeId<"mcpConnector">();
    const slug = `curated-${curatedConnectorId}`;
    const issuer = "https://auth.example.test/curated";
    await testDb.insert(mcpConnectors).values({
      id: curatedConnectorId,
      organizationId,
      slug,
      displayName: "Curated connector",
      description: "",
      url: "https://mcp.example.test/curated",
      authType: "oauth2",
      isCurated: true,
    });
    const audits: unknown[] = [];

    expect(
      await connectAsMember({
        slug,
        issuer,
        curatedApproval: { issuer, endpointOrigins: [] },
        audits,
      }),
    ).toMatchObject({ type: "oauth2" });
    expect(await reviewRows(curatedConnectorId)).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("approval refuses an issuer other than the observed and confirmed one", async () => {
    const changedConnectorId = createSafeId<"mcpConnector">();
    const slug = `changed-${changedConnectorId}`;
    const observedIssuer = "https://auth.example.test/observed";
    await testDb.insert(mcpConnectors).values({
      id: changedConnectorId,
      organizationId,
      slug,
      displayName: "Changed connector",
      description: "",
      url: "https://mcp.example.test/changed",
      authType: "oauth2",
    });
    await testDb.insert(mcpConnectorAuthorizationReviews).values({
      organizationId,
      connectorId: changedConnectorId,
      observedIssuer,
      observedEndpointOrigins: ["https://auth.example.test"],
    });
    const before = await reviewRows(changedConnectorId);
    expect(before).toHaveLength(1);

    expect(
      await approveAuthorization({
        slug,
        discoveredIssuer: "https://auth.example.test/discovered",
        confirmedIssuer: observedIssuer,
        activeOrganizationId: organizationId,
      }),
    ).toMatchObject({ code: 409 });
    expect(await reviewRows(changedConnectorId)).toEqual(before);
  });

  test("approval applies only to the approving organization's review", async () => {
    const slug = `catalogue-${catalogueConnectorId}`;
    const issuer = "https://auth.example.test/catalogue";
    await testDb.insert(organization).values({
      id: otherOrganizationId,
      name: "Other connector organization",
      slug: `connector-${otherOrganizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(mcpConnectors).values({
      id: catalogueConnectorId,
      organizationId: null,
      slug,
      displayName: "Catalogue connector",
      description: "",
      url: "https://mcp.example.test/catalogue",
      authType: "oauth2",
      isCurated: true,
    });
    await testDb.insert(mcpConnectorAuthorizationReviews).values(
      [organizationId, otherOrganizationId].map((reviewOrganizationId) => ({
        organizationId: reviewOrganizationId,
        connectorId: catalogueConnectorId,
        observedIssuer: issuer,
        observedEndpointOrigins: ["https://auth.example.test"],
      })),
    );
    const otherBefore = (await reviewRows(catalogueConnectorId)).filter(
      (row) => row.organizationId === otherOrganizationId,
    );
    expect(otherBefore).toHaveLength(1);

    expect(
      await approveAuthorization({
        slug,
        discoveredIssuer: issuer,
        confirmedIssuer: issuer,
        activeOrganizationId: organizationId,
      }),
    ).toEqual({ approved: true });
    const after = await reviewRows(catalogueConnectorId);
    expect(
      after.filter((row) => row.organizationId === organizationId),
    ).toEqual([
      expect.objectContaining({ status: "approved", approvedIssuer: issuer }),
    ]);
    expect(
      after.filter((row) => row.organizationId === otherOrganizationId),
    ).toEqual(otherBefore);
  });

  test("coordinates token refresh with a fenced lease and due retry", async () => {
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [], organizationId, ownerId),
    );
    const now = new Date("2026-10-03T12:00:00.000Z");
    const firstLease = Result.unwrap(
      await claimMcpRefreshLease({
        safeDb,
        organizationId,
        userId: ownerId,
        connectionId,
        now,
      }),
    );

    expect(firstLease).toEqual(new Date(now.getTime() + 90_000));
    if (firstLease === null) {
      return;
    }
    expect(
      Result.unwrap(
        await claimMcpRefreshLease({
          safeDb,
          organizationId,
          userId: ownerId,
          connectionId,
          now,
        }),
      ),
    ).toBeNull();

    const retryAfter = new Date(now.getTime() + 120_000);
    Result.unwrap(
      await releaseMcpRefreshLease({
        safeDb,
        connectionId,
        leaseExpiresAt: new Date(firstLease.getTime() - 1),
        retryAfter,
      }),
    );
    const afterStaleRelease = await testDb.query.mcpUserConnections.findFirst({
      where: { id: { eq: connectionId } },
      columns: {
        refreshLeaseExpiresAt: true,
        refreshRetryAfter: true,
      },
    });
    expect(afterStaleRelease).toEqual({
      refreshLeaseExpiresAt: firstLease,
      refreshRetryAfter: null,
    });

    Result.unwrap(
      await releaseMcpRefreshLease({
        safeDb,
        connectionId,
        leaseExpiresAt: firstLease,
        retryAfter,
      }),
    );
    expect(
      Result.unwrap(
        await claimMcpRefreshLease({
          safeDb,
          organizationId,
          userId: ownerId,
          connectionId,
          now: new Date(retryAfter.getTime() - 1),
        }),
      ),
    ).toBeNull();

    const retryLease = Result.unwrap(
      await claimMcpRefreshLease({
        safeDb,
        organizationId,
        userId: ownerId,
        connectionId,
        now: retryAfter,
      }),
    );
    expect(retryLease).toEqual(new Date(retryAfter.getTime() + 90_000));

    await testDb
      .update(mcpUserConnections)
      .set({
        refreshLeaseExpiresAt: new Date(now.getTime() - 1),
        refreshRetryAfter: null,
      })
      .where(eq(mcpUserConnections.id, connectionId));
    const afterExpiredLease = Result.unwrap(
      await claimMcpRefreshLease({
        safeDb,
        organizationId,
        userId: ownerId,
        connectionId,
        now,
      }),
    );
    expect(afterExpiredLease).toEqual(new Date(now.getTime() + 90_000));
  });
});

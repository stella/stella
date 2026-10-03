import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  claimMcpRefreshLease,
  releaseMcpRefreshLease,
} from "@/api/lib/mcp-upstream/connections";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { TABLE_POLICY_SETTINGS_BASELINE } from "@/api/tests/security/table-policy-settings-baseline";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const ownerId = mintAuthProviderId<"user">();
const memberId = mintAuthProviderId<"user">();
const connectorId = createSafeId<"mcpConnector">();
const connectionId = createSafeId<"mcpUserConnection">();

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
  // Apply the committed definition, including settings schema push cannot represent.
  await testDb.execute(sql`DROP TABLE mcp_connector_authorization_reviews`);
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
  if (testDb) {
    await testDb
      .delete(organization)
      .where(eq(organization.id, organizationId));
    await testDb.delete(user).where(eq(user.id, ownerId));
    await testDb.delete(user).where(eq(user.id, memberId));
    await releaseTestDb();
  }
});

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

  test("coordinates token refresh with a fenced lease and due retry", async () => {
    const safeDb = createSafeDb(testDb, [], organizationId, ownerId);
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

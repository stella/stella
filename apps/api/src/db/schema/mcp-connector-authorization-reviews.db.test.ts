import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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

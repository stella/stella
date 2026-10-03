import type { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpUserConnections,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type RecordMcpAuthorizationReviewOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  connectorId: SafeId<"mcpConnector">;
  userId: SafeId<"user">;
  observedIssuer: string | null;
  lease?: { connectionId: SafeId<"mcpUserConnection">; expiresAt: Date };
};

export const recordMcpAuthorizationReview = async ({
  safeDb,
  organizationId,
  connectorId,
  userId,
  observedIssuer,
  lease,
}: RecordMcpAuthorizationReviewOptions): Promise<Result<void, SafeDbError>> =>
  await safeDb(async (tx) => {
    // audit: skip — derived connector authorization status; credentials and approved configuration remain unchanged
    if (lease) {
      const changed = await tx
        .update(mcpUserConnections)
        .set({
          status: "needs_approval",
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpUserConnections.id, lease.connectionId),
            eq(mcpUserConnections.organizationId, organizationId),
            eq(mcpUserConnections.userId, userId),
            eq(mcpUserConnections.status, "connected"),
            eq(
              mcpUserConnections.refreshLeaseExpiresAt,
              sql`${lease.expiresAt.toISOString()}::timestamptz`,
            ),
          ),
        )
        .returning({ id: mcpUserConnections.id });
      if (changed.length === 0) {
        return;
      }
    } else {
      await tx
        .insert(mcpUserConnections)
        .values({
          organizationId,
          connectorId,
          userId,
          status: "needs_approval",
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [
            mcpUserConnections.organizationId,
            mcpUserConnections.connectorId,
            mcpUserConnections.userId,
          ],
          set: {
            status: "needs_approval",
            refreshLeaseExpiresAt: null,
            updatedAt: new Date(),
          },
        });
    }
    await tx
      .insert(mcpConnectorAuthorizationReviews)
      .values({ organizationId, connectorId, observedIssuer })
      .onConflictDoUpdate({
        target: [
          mcpConnectorAuthorizationReviews.organizationId,
          mcpConnectorAuthorizationReviews.connectorId,
        ],
        set: { observedIssuer, updatedAt: new Date() },
      });
  });

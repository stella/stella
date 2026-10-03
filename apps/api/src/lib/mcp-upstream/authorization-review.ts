import type { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpUserConnections,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type RecordMcpAuthorizationReviewOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  connectorId: SafeId<"mcpConnector">;
  userId: SafeId<"user">;
  observedIssuer: string | null;
  observedEndpointOrigins?: string[];
  lease?: { connectionId: SafeId<"mcpUserConnection">; expiresAt: Date };
  recordAuditEvent: AuditRecorder;
};

export const recordMcpAuthorizationReview = async ({
  safeDb,
  organizationId,
  connectorId,
  userId,
  observedIssuer,
  observedEndpointOrigins,
  lease,
  recordAuditEvent,
}: RecordMcpAuthorizationReviewOptions): Promise<Result<void, SafeDbError>> =>
  await safeDb(async (tx) => {
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
      .values({
        organizationId,
        connectorId,
        observedIssuer,
        ...(observedEndpointOrigins === undefined
          ? {}
          : { observedEndpointOrigins }),
      })
      .onConflictDoUpdate({
        target: [
          mcpConnectorAuthorizationReviews.organizationId,
          mcpConnectorAuthorizationReviews.connectorId,
        ],
        set: {
          observedIssuer,
          // Keep what an earlier discovery observed when this one has no
          // origins to report; otherwise the review shows the current ones.
          ...(observedEndpointOrigins === undefined
            ? {}
            : { observedEndpointOrigins }),
          status: "needs_reapproval",
          updatedAt: new Date(),
        },
      });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      metadata: {
        field: "mcpConnectorAuthorization",
        connectorId,
        status: "needs_reapproval",
        observedIssuer,
      },
    });
  });

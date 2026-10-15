import { panic } from "better-result";
import type { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpUserConnections,
} from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { McpIssuerBinding } from "@/api/lib/mcp-upstream/oauth";

type ResolveMcpIssuerBindingOptions = {
  curatedApproval: {
    issuer: string;
    endpointOrigins: readonly string[];
  } | null;
  connectorIssuer: string | null;
  connectorConfirmedEndpointOrigins: readonly string[] | null;
  reviewApprovedIssuer: string | null;
  reviewApprovedEndpointOrigins: readonly string[] | null;
};

/**
 * The issuer a connector may use in an organization, by precedence: the
 * organization's approved review, the issuer stored when the connector was
 * created, then the curated catalogue's approval. Endpoint origins come from
 * the same source as the issuer they were approved with.
 */
export const resolveMcpIssuerBinding = ({
  curatedApproval,
  connectorIssuer,
  connectorConfirmedEndpointOrigins,
  reviewApprovedIssuer,
  reviewApprovedEndpointOrigins,
}: ResolveMcpIssuerBindingOptions): McpIssuerBinding => {
  if (reviewApprovedIssuer !== null) {
    return {
      type: "approved",
      issuer: reviewApprovedIssuer,
      endpointOrigins: arrayOrEmpty(reviewApprovedEndpointOrigins),
    };
  }
  if (connectorIssuer !== null) {
    return {
      type: "approved",
      issuer: connectorIssuer,
      endpointOrigins:
        connectorConfirmedEndpointOrigins ??
        (curatedApproval?.issuer === connectorIssuer
          ? curatedApproval.endpointOrigins
          : []),
    };
  }
  if (curatedApproval !== null) {
    return {
      type: "approved",
      issuer: curatedApproval.issuer,
      endpointOrigins: curatedApproval.endpointOrigins,
    };
  }
  return { type: "unconfigured" };
};

export const approvedMcpAuthorizationReview = sql<boolean>`(
  ${mcpConnectorAuthorizationReviews.status} IS NULL OR
  ${mcpConnectorAuthorizationReviews.status} = 'approved'
)`;

/**
 * What recording a review does to the observing user's own connection.
 * `mark` sets it to `needs_approval`; `leased` does so only while the caller
 * still holds that refresh lease, and records nothing once the lease moved
 * on; `unchanged` leaves the connection as it is, so it resumes with its
 * stored tokens once an administrator approves the observed authorization.
 */
type McpReviewConnectionEffect =
  | { type: "mark" }
  | {
      type: "leased";
      connectionId: SafeId<"mcpUserConnection">;
      expiresAt: Date;
    }
  | { type: "unchanged" };

type RecordMcpAuthorizationReviewOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  connectorId: SafeId<"mcpConnector">;
  userId: SafeId<"user">;
  observedIssuer: string | null;
  observedEndpointOrigins?: string[];
  connection: McpReviewConnectionEffect;
  recordAuditEvent: AuditRecorder;
};

type ApplyConnectionEffectOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  connectorId: SafeId<"mcpConnector">;
  userId: SafeId<"user">;
  connection: McpReviewConnectionEffect;
};

/** False when a leased effect lost its lease, so no review is recorded. */
const applyConnectionEffect = async ({
  tx,
  organizationId,
  connectorId,
  userId,
  connection,
}: ApplyConnectionEffectOptions): Promise<boolean> => {
  switch (connection.type) {
    case "unchanged":
      return true;
    case "leased": {
      const changed = await tx
        .update(mcpUserConnections)
        .set({
          status: "needs_approval",
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpUserConnections.id, connection.connectionId),
            eq(mcpUserConnections.organizationId, organizationId),
            eq(mcpUserConnections.userId, userId),
            eq(mcpUserConnections.status, "connected"),
            eq(
              mcpUserConnections.refreshLeaseExpiresAt,
              sql`${connection.expiresAt.toISOString()}::timestamptz`,
            ),
          ),
        )
        .returning({ id: mcpUserConnections.id });
      return changed.length > 0;
    }
    case "mark":
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
      return true;
    default: {
      connection satisfies never;
      return panic("Unhandled MCP review connection effect");
    }
  }
};

export const recordMcpAuthorizationReview = async ({
  safeDb,
  organizationId,
  connectorId,
  userId,
  observedIssuer,
  observedEndpointOrigins,
  connection,
  recordAuditEvent,
}: RecordMcpAuthorizationReviewOptions): Promise<Result<void, SafeDbError>> =>
  await safeDb(async (tx) => {
    if (
      !(await applyConnectionEffect({
        tx,
        organizationId,
        connectorId,
        userId,
        connection,
      }))
    ) {
      return;
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

import { panic } from "better-result";
import { inArray, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { accountExports } from "@/api/db/schema";
import latestOrganizationAuditExport from "@/api/handlers/organizations/audit-export/get";
import { HttpStatusResponse } from "@/api/http/status";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/**
 * The organization's audit trail and the owner's archive history both grow;
 * the read returns the one latest archive and whether it covers the trail.
 */
const seedOrganizationAuditExportScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Audit export scaling organization",
    slug: `org-${organizationId.toLowerCase()}`,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Audit export scaling owner",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    userId,
    workspaceId: null,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "system", source: "audit_export_scaling_fixture" },
    },
  });
  await db.transaction(async (tx) => {
    await recordAuditEvent(
      tx,
      Array.from({ length: size }, () => ({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: organizationId,
      })),
    );
  });
  // Only one archive per account and organization may be active; grow the
  // expired history around the ready one instead of bypassing that index.
  await db.insert(accountExports).values(
    Array.from({ length: size - 1 }, () => ({
      id: Bun.randomUUIDv7(),
      userId,
      kind: "organization_audit" as const,
      organizationId,
      status: "expired" as const,
    })),
  );
  const exportId = Bun.randomUUIDv7();
  await db.insert(accountExports).values({
    id: exportId,
    userId,
    kind: "organization_audit",
    organizationId,
    status: "ready",
    attemptCount: 1,
    objectKey: `account-exports/${userId}/${exportId}/scaling.zip`,
    auditRowCount: size,
    expiresAt: sql`clock_timestamp() + interval '1 hour'`,
    downloadedAt: sql`clock_timestamp()`,
  });
  return {
    organizationId,
    userId,
    exportId,
    cleanup: async () => {
      await db
        .delete(accountExports)
        .where(inArray(accountExports.userId, [userId]));
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(inArray(user.id, [userId]));
    },
  };
};

type OrganizationAuditExportScalingFixture = Awaited<
  ReturnType<typeof seedOrganizationAuditExportScaling>
>;

export const organizationAuditExportScalingScenario = {
  name: "organization audit export latest",
  definition: latestOrganizationAuditExport,
  seed: seedOrganizationAuditExportScaling,
  measure: async (fixture: OrganizationAuditExportScalingFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await latestOrganizationAuditExport.handler(
        createTestHandlerContext<
          Parameters<typeof latestOrganizationAuditExport.handler>[0]
        >({
          user: { id: fixture.userId },
          session: { activeOrganizationId: fixture.organizationId },
          route: "/v1/organizations/audit-export",
          request: new Request(
            "https://example.test/v1/organizations/audit-export",
          ),
          // The read records nothing and reaches the database through the
          // account export store's own connection.
          audit: NO_AUDIT,
          safeDb: NO_DB,
          scopedDb: NO_DB,
        }),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("The owner must read the latest audit archive");
      }
      const latest = response.latest;
      if (
        latest?.id !== fixture.exportId ||
        latest.status !== "ready" ||
        !latest.coversCurrentTrail
      ) {
        return panic("The latest archive must be ready and current");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};

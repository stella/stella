import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia";

import { organization, user } from "@/api/db/auth-schema";
import { auditLogs, organizationDataExports } from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import downloadDataExport from "@/api/handlers/data-exports/download";
import readDataExport from "@/api/handlers/data-exports/get";
import listDataExports from "@/api/handlers/data-exports/list";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { dataExportObjectKey } from "@/api/lib/data-export/queue";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

export const seedDataExportReadScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const exportIds = Array.from({ length: size }, () =>
    createSafeId<"dataExport">(),
  );
  const exportId =
    exportIds.at(0) ?? panic("Export scaling requires an export");
  const rlsDb = markRlsDatabase(db);
  const scopedDb = createScopedDb(rlsDb, [], organizationId, userId);
  const safeDb = createSafeDb(rlsDb, [], organizationId, userId);
  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: { id: userId, type: "user" },
      trigger: { type: "user_dispatch", source: "action", userId },
    },
    organizationId,
    workspaceId: null,
    userId,
  });
  const cleanup = async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Export read fixture",
      slug: organizationId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(user).values({
      id: userId,
      name: "Export reader",
      email: `${userId}@example.test`,
    });
    await scopedDb(
      async (tx) =>
        await tx.insert(organizationDataExports).values(
          exportIds.map((id, index) => ({
            id,
            organizationId,
            requestedBy: userId,
            versionScope: "all" as const,
            status: "ready" as const,
            attempt: 1,
            partCount: 1,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
            expiresAt: new Date("2030-01-01T00:00:00Z"),
            // Internal plan and per-part matter IDs grow with the population;
            // neither is exposed by the fixed-page or detail projections.
            plan: {
              parts: [
                {
                  index: 1,
                  matterIds: Array.from({ length: size }, () =>
                    createSafeId<"workspace">(),
                  ),
                  estimatedBytes: size,
                },
              ],
              mattersTotal: size,
              bytesTotal: size,
            },
            parts: [
              {
                index: 1,
                attempt: 1,
                fileName: "part-0001.zip",
                sizeBytes: 100,
                sha256: "a".repeat(64),
                matterIds: Array.from({ length: size }, () =>
                  createSafeId<"workspace">(),
                ),
                fileCount: 1,
                totals: {
                  matters: size,
                  documents: 1,
                  versions: 1,
                  files: 1,
                  fileBytes: 100,
                },
                problems: [],
              },
            ],
          })),
        ),
    );
    return {
      organizationId,
      userId,
      exportId,
      safeDb,
      recordAuditEvent,
      db,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

type ExportReadFixture = Awaited<ReturnType<typeof seedDataExportReadScaling>>;

export const dataExportReadScalingScenarios = [
  {
    name: "organization export list",
    handler: listDataExports.handler,
    expectedRows: 10,
    measure: async (fixture: ExportReadFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listDataExports.handler(
          createTestHandlerContext<
            Parameters<typeof listDataExports.handler>[0]
          >({
            safeDb: fixture.safeDb,
            scopedDb: NO_DB,
            audit: NO_AUDIT,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            query: { limit: 10 },
          }),
        );
        if (
          response instanceof ElysiaCustomStatusResponse ||
          response.items.length !== 10
        ) {
          panic("Export list scaling requires a full successful page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
  {
    name: "organization export detail",
    handler: readDataExport.handler,
    expectedRows: 1,
    measure: async (fixture: ExportReadFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readDataExport.handler(
          createTestHandlerContext<
            Parameters<typeof readDataExport.handler>[0]
          >({
            safeDb: fixture.safeDb,
            scopedDb: NO_DB,
            audit: NO_AUDIT,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            params: { exportId: fixture.exportId },
          }),
        );
        if (
          response instanceof ElysiaCustomStatusResponse ||
          response.id !== fixture.exportId ||
          response.parts.length !== 1
        ) {
          panic("Export detail scaling requires its seeded export and part");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "organization export download grant",
    handler: downloadDataExport.handler,
    expectedRows: 1,
    measure: async (fixture: ExportReadFixture) => {
      const session = {
        id: Bun.randomUUIDv7(),
        activeOrganizationId: fixture.organizationId,
      };
      const measured = await runWithMeasuredQueryCounter(async (counter) => {
        const response = await downloadDataExport.handler(
          createTestHandlerContext<
            Parameters<typeof downloadDataExport.handler>[0]
          >({
            safeDb: fixture.safeDb,
            scopedDb: NO_DB,
            audit: fixture.recordAuditEvent,
            user: { id: fixture.userId },
            session,
            params: { exportId: fixture.exportId },
            body: { file: { type: "part", index: 1 } },
          }),
        );
        if (response instanceof ElysiaCustomStatusResponse) {
          panic("Export grant scaling requires a successful grant");
        }
        const signed = new URL(response.url);
        if (
          !signed.pathname.endsWith(
            `/${dataExportObjectKey({
              organizationId: fixture.organizationId,
              exportId: fixture.exportId,
              attempt: 1,
              fileName: "part-0001.zip",
            })}`,
          ) ||
          signed.searchParams.get("X-Amz-Expires") !== "900" ||
          !signed.searchParams.has("X-Amz-Signature") ||
          response.sizeBytes !== 100 ||
          response.sha256 !== "a".repeat(64)
        ) {
          panic("Export grant scaling must sign the actual seeded part");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      });
      const audits = await fixture.db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, fixture.organizationId),
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.DATA_EXPORT),
            eq(auditLogs.resourceId, fixture.exportId),
          ),
        )
        .limit(2);
      if (
        audits.length !== 1 ||
        audits.at(0)?.action !== AUDIT_ACTION.DOWNLOAD
      ) {
        panic("Export grant scaling requires its real committed audit event");
      }
      return measured;
    },
  },
];

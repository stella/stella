import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { rlsDb, rootDb } from "@/api/db/root";
import { accountExports, auditLogs } from "@/api/db/schema";
import { buildOrganizationAuditArchive } from "@/api/lib/account-export/organization-audit-archive";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import {
  claimAccountExport,
  completeAccountExport,
  requestOrganizationAuditExport,
} from "@/api/lib/account-export/store";
import type {
  AccountExportDb,
  OrganizationAuditCoverage,
} from "@/api/lib/account-export/store";
import type { SafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type CompleteOrganizationAuditExportOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  /** The database the application's root and request connections reach. */
  db: typeof rootDb;
  scopedDatabase: typeof rlsDb;
};

export type CompletedOrganizationAuditExport = {
  exportId: string;
  objectKey: string;
  coverage: OrganizationAuditCoverage;
  /** The archive bytes the build published, in place of the bucket. */
  archive: Uint8Array<ArrayBuffer>;
};

/**
 * Drive one organization audit export through the real ledger and builder:
 * request, claim, build and complete, with only the bucket upload captured.
 */
export const completeOrganizationAuditExport = async ({
  userId,
  organizationId,
  db,
  scopedDatabase,
}: CompleteOrganizationAuditExportOptions): Promise<CompletedOrganizationAuditExport> => {
  const ledger: AccountExportDb & AccountExportDataDb = db;
  const requested = (
    await requestOrganizationAuditExport({ userId, organizationId, db: ledger })
  ).unwrap();
  const claim =
    (await claimAccountExport(requested.id, ledger)) ??
    panic("Requested organization audit export must be claimable");
  let archive: Uint8Array<ArrayBuffer> | undefined;
  const coverage = await buildOrganizationAuditArchive({
    db: ledger,
    userId,
    organizationId,
    objectKey: claim.objectKey,
    signal: AbortSignal.timeout(60_000),
    scopedDatabase,
    publish: async (key, body) => {
      if (key !== claim.objectKey) {
        panic("Archive published under a key other than its claim");
      }
      archive =
        body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : new Uint8Array(body);
    },
  });
  const completed = await completeAccountExport({
    claim,
    objectKey: claim.objectKey,
    built: { kind: "organization_audit", coverage },
    db: ledger,
  });
  if (!completed) {
    panic("Claimed organization audit export must complete");
  }
  return {
    exportId: requested.id,
    objectKey: claim.objectKey,
    coverage,
    archive: archive ?? panic("Organization audit archive was not published"),
  };
};

type SeedReadyOrganizationAuditExportOptions = {
  db: TestDatabase;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

/**
 * Record a ready, downloaded audit archive that holds the organization's
 * current trail, for suites whose subject is what deletion does after its
 * precondition.
 */
export const seedReadyOrganizationAuditExport = async ({
  db,
  userId,
  organizationId,
}: SeedReadyOrganizationAuditExportOptions): Promise<string> => {
  const id = Bun.randomUUIDv7();
  await db
    .delete(accountExports)
    .where(
      and(
        eq(accountExports.userId, userId),
        eq(accountExports.organizationId, organizationId),
      ),
    );
  const counted = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId));
  await db.insert(accountExports).values({
    id,
    userId,
    kind: "organization_audit",
    organizationId,
    status: "ready",
    attemptCount: 1,
    objectKey: `account-exports/${userId}/${id}/seeded.zip`,
    auditRowCount: counted.at(0)?.count ?? 0,
    expiresAt: sql`clock_timestamp() + interval '1 hour'`,
    downloadedAt: sql`clock_timestamp()`,
  });
  return id;
};

/** Account exports restrict their account's deletion; suites clear them first. */
export const deleteAccountExports = async (
  db: TestDatabase,
  userId: SafeId<"user">,
): Promise<void> => {
  await db.delete(accountExports).where(eq(accountExports.userId, userId));
};

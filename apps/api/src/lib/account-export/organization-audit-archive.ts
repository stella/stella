import { and, asc, eq, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";

import { Temporal } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import type { rlsDb } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  ACCOUNT_EXPORT_ARCHIVE_LIMITS,
  AccountExportArchiveError,
  spoolAndPublishZip,
} from "@/api/lib/account-export/archive";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import type { OrganizationAuditCoverage } from "@/api/lib/account-export/store";
import {
  AUDIT_LOG_EXPORT_CSV_HEADER,
  auditLogExportColumns,
  auditLogExportCsvLine,
  readAuditLogExportActors,
} from "@/api/lib/audit-log-export";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { putTemporaryS3ObjectWithSignal } from "@/api/lib/s3";

const ORGANIZATION_AUDIT_ARCHIVE_PAGE_SIZE = 500;

/** The archive's table of audit rows, in the admin export's columns. */
export const ORGANIZATION_AUDIT_ARCHIVE_TABLE = "audit-logs.csv";

type BuildOrganizationAuditArchiveOptions = {
  db: AccountExportDataDb;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  objectKey: string;
  signal: AbortSignal;
  scopedDatabase?: typeof rlsDb;
  publish?: typeof putTemporaryS3ObjectWithSignal;
};

const resolveScopedDatabase = async () => {
  const { rlsDb } = await import("@/api/db/root");
  return rlsDb;
};

/** The archive is built for an owner; one who has since left gets none. */
const requireOwner = async (
  db: AccountExportDataDb,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
) => {
  const owners = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, userId),
        eq(member.role, "owner"),
      ),
    )
    .limit(1);
  if (owners.length === 0) {
    throw new AccountExportArchiveError({
      message:
        "Organization audit export requires an owner of the organization",
    });
  }
};

/**
 * Build one archive of every audit row of the organization, in creation order,
 * and report what it holds. The count is what deletion compares with the live
 * trail: the trail is append-only, so an archive whose count matches holds
 * every row, including any row a page boundary would have missed.
 */
export const buildOrganizationAuditArchive = async ({
  db,
  userId,
  organizationId,
  objectKey,
  signal,
  scopedDatabase,
  publish = putTemporaryS3ObjectWithSignal,
}: BuildOrganizationAuditArchiveOptions): Promise<OrganizationAuditCoverage> => {
  await requireOwner(db, { organizationId, userId });
  const scopedDb = createScopedDb(
    scopedDatabase ?? (await resolveScopedDatabase()),
    [],
    organizationId,
    userId,
  );
  const readContext = {
    featureAccessSnapshot: await scopedDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({ tx, organizationId, userId }),
    ),
    principal: { organizationId, userId },
  };
  const generatedAt = Temporal.Now.instant().toString();
  const encoder = new TextEncoder();
  const coverage: OrganizationAuditCoverage = {
    rowCount: 0,
    coveredThrough: null,
  };

  // Keyset on (created_at, id). The cursor's time travels as text so it keeps
  // the column's microseconds, which a JavaScript Date would round away.
  type Cursor = { createdAt: string; id: string };
  const readPage = async (after: Cursor | null) =>
    await scopedDb(async (tx) => {
      const rows = await tx
        .select({
          ...auditLogExportColumns(readContext),
          id: auditLogs.id,
          cursorCreatedAt: sql<string>`${auditLogs.createdAt}::text`,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            after === null
              ? undefined
              : sql`(${auditLogs.createdAt}, ${auditLogs.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
        .limit(ORGANIZATION_AUDIT_ARCHIVE_PAGE_SIZE);
      const actors = await readAuditLogExportActors(
        tx,
        organizationId,
        rows.map((row) => row.userId),
      );
      return { rows, actors };
    });

  const auditTable = async function* () {
    yield encoder.encode(AUDIT_LOG_EXPORT_CSV_HEADER);
    let cursor: Cursor | null = null;
    for (;;) {
      signal.throwIfAborted();
      // db-await-in-loop: one bounded keyset page at a time keeps the archive streaming within its memory and size ceilings
      const { rows, actors } = await readPage(cursor);
      for (const row of rows) {
        const line = `\n${auditLogExportCsvLine({
          row,
          actor: actors.get(row.userId),
          ...readContext,
        })}`;
        if (
          Buffer.byteLength(line, "utf-8") >
          ACCOUNT_EXPORT_ARCHIVE_LIMITS.recordBytes
        ) {
          throw new AccountExportArchiveError({
            message: "Account export record exceeds its size limit",
          });
        }
        yield encoder.encode(line);
        coverage.rowCount += 1;
        coverage.coveredThrough = row.createdAt;
      }
      const last = rows.at(-1);
      if (
        last === undefined ||
        rows.length < ORGANIZATION_AUDIT_ARCHIVE_PAGE_SIZE
      ) {
        return;
      }
      cursor = { createdAt: last.cursorCreatedAt, id: last.id };
    }
  };

  const entries = async function* () {
    yield { name: ORGANIZATION_AUDIT_ARCHIVE_TABLE, input: auditTable() };
    // client-zip consumes each entry before requesting the next, so the
    // count below describes the rows written. An organization deleted while
    // the archive was being read leaves no owner, and no archive.
    await requireOwner(db, { organizationId, userId });
    yield {
      name: "manifest.json",
      input: encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          kind: "organization_audit",
          generatedAt,
          organizationId,
          auditRowCount: coverage.rowCount,
          coveredThrough:
            coverage.coveredThrough === null
              ? null
              : Temporal.Instant.fromEpochMilliseconds(
                  coverage.coveredThrough.getTime(),
                ).toString(),
        }),
      ),
    };
  };

  await spoolAndPublishZip({ entries: entries(), objectKey, signal, publish });
  return coverage;
};

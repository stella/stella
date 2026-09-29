import { panic } from "better-result";
import { and, asc, count, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import type { OrganizationFileLedgerCursor } from "@/api/lib/files/organization-file-usage-queries";
import { organizationFileLedgerPageQuery } from "@/api/lib/files/organization-file-usage-queries";

const PAGE_SIZE = 200;

/** Temporary objects may use the legacy root prefix or an organization scope. */
export const isTemporaryOrganizationObjectKey = (
  organizationId: SafeId<"organization">,
  key: string,
): boolean => {
  const segments = key.split("/");
  return (
    segments[0] === "tmp" ||
    (segments[0] === organizationId &&
      (segments[1] === "tmp" || segments[2] === "tmp"))
  );
};

type ReconcileAbsentOptions = {
  db: Pick<MaintenanceDb, "transaction">;
  objectExists: (key: string) => Promise<boolean>;
  staleBefore: Date;
};

/** Walk the global tenant/key index and settle each page with one grouped mutation. */
export const reconcileAbsentOrganizationFileObjects = async ({
  db,
  objectExists,
  staleBefore,
}: ReconcileAbsentOptions): Promise<number> => {
  let cursor: OrganizationFileLedgerCursor | null = null;
  let removed = 0;
  const reconcilePage = async (after: OrganizationFileLedgerCursor | null) => {
    const rows = await db.transaction(
      async (tx) =>
        await organizationFileLedgerPageQuery({
          db: tx,
          cursor: after,
          limit: PAGE_SIZE,
        }),
    );
    const absent: {
      organizationId: SafeId<"organization">;
      objectKey: string;
      writeId: string | null;
      action: "release" | "remove";
    }[] = [];
    for (const row of rows) {
      if (row.status === "reserved" || row.pendingSizeBytes !== null) {
        if (
          row.writeId === null ||
          row.reservationStartedAt === null ||
          row.reservationStartedAt >= staleBefore ||
          (await objectExists(row.objectKey))
        ) {
          continue;
        }
        absent.push({
          organizationId: row.organizationId,
          objectKey: row.objectKey,
          writeId: row.writeId,
          action: "release",
        });
        continue;
      }
      if (
        !isTemporaryOrganizationObjectKey(row.organizationId, row.objectKey) &&
        (await objectExists(row.objectKey))
      ) {
        continue;
      }
      absent.push({
        organizationId: row.organizationId,
        objectKey: row.objectKey,
        writeId: null,
        action: "remove",
      });
    }
    if (absent.length === 0) {
      return { rows, deleted: 0 };
    }
    const deleted = await db.transaction(async (tx) => {
      const organizationIds = [
        ...new Set(absent.map((row) => row.organizationId)),
      ].toSorted();
      const counters = await tx
        .select({ organizationId: organizationFileUsage.organizationId })
        .from(organizationFileUsage)
        .where(inArray(organizationFileUsage.organizationId, organizationIds))
        .orderBy(asc(organizationFileUsage.organizationId))
        .limit(organizationIds.length)
        .for("update");
      if (counters.length !== organizationIds.length) {
        return panic("Organization file counter disappeared during backfill");
      }
      const current = await tx
        .select()
        .from(organizationFileObjects)
        .where(
          inArray(
            organizationFileObjects.objectKey,
            absent.map((row) => row.objectKey),
          ),
        )
        .limit(absent.length);
      const byKey = new Map(current.map((row) => [row.objectKey, row]));
      const confirmed: typeof absent = [];
      for (const candidate of absent) {
        const row = byKey.get(candidate.objectKey);
        if (
          !row ||
          row.organizationId !== candidate.organizationId ||
          row.writeId !== candidate.writeId
        ) {
          continue;
        }
        if (candidate.action === "release") {
          if (row.status === "reserved" || row.pendingSizeBytes !== null) {
            confirmed.push(candidate);
          }
          continue;
        }
        if (row.status !== "committed" || row.pendingSizeBytes !== null) {
          continue;
        }
        // A second HEAD under the counter lock preserves a newer committed write.
        if (
          !isTemporaryOrganizationObjectKey(
            row.organizationId,
            row.objectKey,
          ) &&
          (await objectExists(row.objectKey))
        ) {
          continue;
        }
        confirmed.push(candidate);
      }
      if (confirmed.length === 0) {
        return 0;
      }
      await tx.execute(sql`
        with input as (select * from jsonb_to_recordset(${JSON.stringify(confirmed)}::text::jsonb) as x("organizationId" text, "objectKey" text, "writeId" text, action text)),
        matched as (select o.*, i.action from organization_file_objects o join input i on o.organization_id = i."organizationId" and o.object_key = i."objectKey" and o.write_id is not distinct from i."writeId"),
        removed as (delete from organization_file_objects o using matched m where o.object_key = m.object_key and (m.action = 'remove' or m.status = 'reserved') returning o.object_key),
        updated as (update organization_file_objects o set pending_size_bytes = null, write_id = null, expected_sha256_hex = null, reservation_started_at = null, updated_at = now() from matched m where o.object_key = m.object_key and m.action = 'release' and m.status = 'committed' returning o.object_key),
        changed as (select object_key from removed union all select object_key from updated),
        deltas as (select m.organization_id,
          sum(case when m.action = 'remove' then m.size_bytes else 0 end) as committed,
          sum(case when m.action = 'release' then case when m.status = 'reserved' then m.size_bytes else greatest(m.pending_size_bytes - m.size_bytes, 0) end else 0 end) as reserved
          from matched m join changed c on c.object_key = m.object_key group by m.organization_id)
        update organization_file_usage u set committed_bytes = u.committed_bytes - d.committed, reserved_bytes = u.reserved_bytes - d.reserved, updated_at = now()
        from deltas d where u.organization_id = d.organization_id
      `);
      return confirmed.filter((row) => row.action === "remove").length;
    });
    return { rows, deleted };
  };
  for (;;) {
    // db-await-in-loop: the global tenant/key page supplies the next tuple cursor and settles before advancing
    const { rows, deleted } = await reconcilePage(cursor);
    removed += deleted;
    const last = rows.at(-1);
    if (!last) {
      break;
    }
    cursor = { organizationId: last.organizationId, objectKey: last.objectKey };
    if (rows.length < PAGE_SIZE) {
      break;
    }
  }
  return removed;
};

type BackfillCounts = {
  imported: number;
  removed: number;
  settledReservations: number;
  mismatchedReservations: number;
};

/**
 * Print the run summary, then return the unsettled writes beyond the
 * mismatched reservations that reconciliation deliberately leaves pending.
 */
export const reportOrganizationFileUsageBackfill = async ({
  counts,
  db,
  log,
}: {
  counts: BackfillCounts;
  db: Pick<MaintenanceDb, "transaction">;
  log: (line: string) => void;
}): Promise<number> => {
  const unsettled = await db.transaction(
    async (tx) =>
      await tx
        .select({ rows: count() })
        .from(organizationFileObjects)
        .where(
          and(
            isNotNull(organizationFileObjects.writeId),
            or(
              eq(organizationFileObjects.status, "reserved"),
              isNotNull(organizationFileObjects.pendingSizeBytes),
            ),
          ),
        )
        .then((rows) => rows.at(0)?.rows ?? 0),
  );
  log(
    `Reconciled ${counts.imported} stored objects; removed ${counts.removed} absent ledger rows; settled ${counts.settledReservations} reservations; ${counts.mismatchedReservations} mismatched reservations remain pending; ${unsettled} unsettled writes remain.`,
  );
  return Math.max(0, unsettled - counts.mismatchedReservations);
};

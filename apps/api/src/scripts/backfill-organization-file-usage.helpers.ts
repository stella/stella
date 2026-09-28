import { panic, Result } from "better-result";
import { and, asc, eq, gt } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { releaseOrganizationFileBytes } from "@/api/lib/files/organization-file-usage";

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
  organizationId: SafeId<"organization">;
  objectExists: (key: string) => Promise<boolean>;
  staleBefore: Date;
};

/** Check committed ledger rows in keyset pages; each confirmed absence is removed atomically. */
export const reconcileAbsentOrganizationFileObjects = async ({
  db,
  organizationId,
  objectExists,
  staleBefore,
}: ReconcileAbsentOptions): Promise<number> => {
  let cursor: string | null = null;
  let removed = 0;
  const readPage = async (afterKey: string | null) =>
    await db.transaction(
      async (tx) =>
        await tx
          .select({
            objectKey: organizationFileObjects.objectKey,
            status: organizationFileObjects.status,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
            reservationStartedAt: organizationFileObjects.reservationStartedAt,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(organizationFileObjects.organizationId, organizationId),
              afterKey === null
                ? undefined
                : gt(organizationFileObjects.objectKey, afterKey),
            ),
          )
          .orderBy(asc(organizationFileObjects.objectKey))
          .limit(PAGE_SIZE),
    );
  for (;;) {
    const rows = await readPage(cursor);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const { objectKey } = row;
      if (row.status === "reserved" || row.pendingSizeBytes !== null) {
        if (
          row.writeId === null ||
          row.reservationStartedAt === null ||
          row.reservationStartedAt >= staleBefore ||
          (await objectExists(objectKey))
        ) {
          continue;
        }
        const released = await releaseOrganizationFileBytes(
          {
            status: "reserved",
            organizationId,
            objectKey,
            writeId: row.writeId,
          },
          db,
        );
        if (Result.isError(released)) {
          throw released.error;
        }
        continue;
      }
      if (
        !isTemporaryOrganizationObjectKey(organizationId, objectKey) &&
        (await objectExists(objectKey))
      ) {
        continue;
      }
      const deleted = await db.transaction(async (tx) => {
        const counter = await tx
          .select({ committedBytes: organizationFileUsage.committedBytes })
          .from(organizationFileUsage)
          .where(eq(organizationFileUsage.organizationId, organizationId))
          .for("update")
          .then((current) => current.at(0));
        const current = await tx
          .select({
            sizeBytes: organizationFileObjects.sizeBytes,
            status: organizationFileObjects.status,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(organizationFileObjects.organizationId, organizationId),
              eq(organizationFileObjects.objectKey, objectKey),
            ),
          )
          .then((matches) => matches.at(0));
        if (!counter) {
          return panic("Organization file counter disappeared during backfill");
        }
        if (
          current?.status !== "committed" ||
          current.pendingSizeBytes !== null ||
          current.writeId !== null
        ) {
          return false;
        }
        await tx
          .delete(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey));
        await tx
          .update(organizationFileUsage)
          .set({
            committedBytes: counter.committedBytes - current.sizeBytes,
            updatedAt: new Date(),
          })
          .where(eq(organizationFileUsage.organizationId, organizationId));
        return true;
      });
      if (deleted) {
        removed += 1;
      }
    }
    cursor = rows.at(-1)?.objectKey ?? null;
    if (cursor === null) {
      return panic("Ledger page ended without a cursor");
    }
    if (rows.length < PAGE_SIZE) {
      break;
    }
  }
  return removed;
};

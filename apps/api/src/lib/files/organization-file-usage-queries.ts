import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  FILE_USAGE_RECONCILIATION_STATE,
  organizationFileObjects,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type OrganizationFileLedgerCursor = {
  organizationId: SafeId<"organization">;
  objectKey: string;
};

type FileLedgerPageOptions = {
  db: Pick<Transaction, "select">;
  cursor: OrganizationFileLedgerCursor | null;
  limit: number;
};

export const organizationFileLedgerPageQuery = ({
  db,
  cursor,
  limit,
}: FileLedgerPageOptions) =>
  db
    .select({
      organizationId: organizationFileObjects.organizationId,
      objectKey: organizationFileObjects.objectKey,
      status: organizationFileObjects.status,
      pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
      writeId: organizationFileObjects.writeId,
      reservationStartedAt: organizationFileObjects.reservationStartedAt,
    })
    .from(organizationFileObjects)
    .where(
      cursor === null
        ? undefined
        : sql`(${organizationFileObjects.organizationId}, ${organizationFileObjects.objectKey}) > (${cursor.organizationId}, ${cursor.objectKey})`,
    )
    .orderBy(
      asc(organizationFileObjects.organizationId),
      asc(organizationFileObjects.objectKey),
    )
    .limit(limit);

type FileReservationCandidatesOptions = {
  db: Pick<Transaction, "select">;
  organizationId?: SafeId<"organization"> | undefined;
  reconcileBefore: Date;
  staleBefore: Date;
  limit: number;
};

export const organizationFileReservationCandidatesQuery = ({
  db,
  organizationId,
  reconcileBefore,
  staleBefore,
  limit,
}: FileReservationCandidatesOptions) =>
  db
    .select({
      objectKey: organizationFileObjects.objectKey,
      organizationId: organizationFileObjects.organizationId,
      writeId: organizationFileObjects.writeId,
    })
    .from(organizationFileObjects)
    .where(
      and(
        or(
          eq(organizationFileObjects.status, "reserved"),
          and(
            eq(organizationFileObjects.status, "committed"),
            isNotNull(organizationFileObjects.pendingSizeBytes),
          ),
        ),
        isNotNull(organizationFileObjects.writeId),
        eq(
          organizationFileObjects.reconciliationState,
          FILE_USAGE_RECONCILIATION_STATE.ACTIVE,
        ),
        lte(
          organizationFileObjects.reconcileAfter,
          sql`${reconcileBefore}::timestamptz`,
        ),
        lte(
          organizationFileObjects.reservationStartedAt,
          sql`${staleBefore}::timestamptz`,
        ),
        organizationId === undefined
          ? undefined
          : eq(organizationFileObjects.organizationId, organizationId),
      ),
    )
    .orderBy(
      asc(organizationFileObjects.reconcileAfter),
      asc(organizationFileObjects.objectKey),
    )
    .limit(limit);

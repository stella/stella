import { panic, Result } from "better-result";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  chatThreads,
  desktopEditSessions,
  documentProcessingRuns,
  fields,
  folioCollabRooms,
  organizationFileObjects,
  organizationFileUsage,
  reportExports,
  styleSets,
  templates,
  templateVersions,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  commitOrganizationFileBytes,
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
  releaseOrganizationFileBytes,
} from "@/api/lib/files/organization-file-usage";

export const ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT = 50;
const RETRY_DELAY_MS = 5 * 60_000;
const UUID_KEY_PART = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const S3_LAST_MODIFIED_PRECISION_MS = 1000;

type ReconcileOptions = {
  db: Pick<MaintenanceDb, "transaction">;
  organizationId?: SafeId<"organization">;
  limit?: number;
  signal?: AbortSignal;
};

/** A row is durable only when the key, or its exact minted object ID, is named by a persisted owner. */
const isDurablyReferenced = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  objectKey: string,
): Promise<boolean> => {
  const parts = objectKey.split("/");
  const fileName = parts.at(-1) ?? "";
  const extensionAt = fileName.lastIndexOf(".");
  const fileId = extensionAt === -1 ? "" : fileName.slice(0, extensionAt);
  const uuidFileId = UUID_KEY_PART.test(fileId) ? fileId : null;
  const workspaceId =
    parts.at(0) === organizationId &&
    parts.length === 3 &&
    UUID_KEY_PART.test(parts[1] ?? "") &&
    uuidFileId !== null
      ? parts[1]
      : null;
  const ocrRunId =
    parts.at(0) === organizationId &&
    parts.length === 4 &&
    parts[2] === "ocr" &&
    fileName.endsWith(".pdf") &&
    uuidFileId !== null
      ? uuidFileId
      : null;
  const thumbnailUserId = parts.length === 2 ? parts[0] : null;
  const rows = await tx
    .select({
      referenced: sql<boolean>`
    COALESCE(
      (SELECT TRUE FROM ${userFiles}
        INNER JOIN ${chatThreads} ON ${chatThreads}.${chatThreads.id} = ${userFiles}.${userFiles.threadId}
        WHERE ${chatThreads}.${chatThreads.organizationId} = ${organizationId}
          AND ${userFiles}.${userFiles.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${templates} WHERE ${templates.organizationId} = ${organizationId} AND ${templates.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${templateVersions} WHERE ${templateVersions.organizationId} = ${organizationId} AND ${templateVersions.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${styleSets} WHERE ${styleSets.organizationId} = ${organizationId} AND ${styleSets.s3Key} = ${objectKey} AND ${styleSets.deletedAt} IS NULL LIMIT 1),
      (SELECT TRUE FROM ${reportExports}
        INNER JOIN ${workspaces} ON ${workspaces}.${workspaces.id} = ${reportExports}.${reportExports.workspaceId}
        WHERE ${workspaces}.${workspaces.organizationId} = ${organizationId}
          AND ${reportExports}.${reportExports.resultS3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${userFiles}
        INNER JOIN ${chatThreads} ON ${chatThreads}.${chatThreads.id} = ${userFiles}.${userFiles.threadId}
        WHERE ${chatThreads}.${chatThreads.organizationId} = ${organizationId}
          AND ${userFiles}.${userFiles.userId} = ${thumbnailUserId}
          AND ${userFiles}.${userFiles.thumbnailFileId} = ${fileId} LIMIT 1),
      (SELECT TRUE FROM ${fields}
        INNER JOIN ${workspaces} ON ${workspaces}.${workspaces.id} = ${fields}.${fields.workspaceId}
        WHERE ${fields}.${fields.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces}.${workspaces.organizationId} = ${organizationId}
          AND ${fields}.${fields.content}->>'type' = 'file'
          AND (${fields}.${fields.content}->>'id' = ${uuidFileId}
            OR ${fields}.${fields.content}->>'pdfFileId' = ${uuidFileId}
            OR ${fields}.${fields.content}->>'thumbnailFileId' = ${uuidFileId}) LIMIT 1),
      (SELECT TRUE FROM ${desktopEditSessions}
        INNER JOIN ${workspaces} ON ${workspaces}.${workspaces.id} = ${desktopEditSessions}.${desktopEditSessions.workspaceId}
        WHERE ${desktopEditSessions}.${desktopEditSessions.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces}.${workspaces.organizationId} = ${organizationId}
          AND ${desktopEditSessions}.${desktopEditSessions.checkpointFileId} = ${uuidFileId}::uuid
          AND ${desktopEditSessions}.${desktopEditSessions.checkpointSizeBytes} IS NOT NULL LIMIT 1),
      (SELECT TRUE FROM ${folioCollabRooms}
        INNER JOIN ${workspaces} ON ${workspaces}.${workspaces.id} = ${folioCollabRooms}.${folioCollabRooms.workspaceId}
        WHERE ${folioCollabRooms}.${folioCollabRooms.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces}.${workspaces.organizationId} = ${organizationId}
          AND ((${folioCollabRooms}.${folioCollabRooms.yjsSnapshotFileId} = ${uuidFileId}::uuid AND ${folioCollabRooms}.${folioCollabRooms.yjsSnapshotSizeBytes} IS NOT NULL)
            OR (${folioCollabRooms}.${folioCollabRooms.docxCheckpointFileId} = ${uuidFileId}::uuid AND ${folioCollabRooms}.${folioCollabRooms.docxCheckpointSizeBytes} IS NOT NULL)) LIMIT 1),
      (SELECT TRUE FROM ${documentProcessingRuns}
        WHERE ${documentProcessingRuns.organizationId} = ${organizationId}
          AND ${documentProcessingRuns.id} = ${ocrRunId}::uuid LIMIT 1),
      FALSE
    )
  `,
    })
    .from(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, organizationId))
    .limit(1);
  return (
    rows.at(0)?.referenced ?? panic("File reference lookup returned no row")
  );
};

/** A bounded sweep settles old fresh-key writes without relying on a retry of the same key. */
export const reconcileAbandonedOrganizationFileReservations = async ({
  db,
  organizationId,
  limit = ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT,
  signal,
}: ReconcileOptions) =>
  await Result.gen(async function* () {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT
    ) {
      return panic("Invalid file reservation reconciliation limit");
    }
    signal?.throwIfAborted();
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - FILE_RESERVATION_ABANDON_DELAY_MS,
    );
    const retryBefore = new Date(now.getTime() - RETRY_DELAY_MS);
    const candidates = await db.transaction(
      async (tx) =>
        await tx
          .select({
            objectKey: organizationFileObjects.objectKey,
            organizationId: organizationFileObjects.organizationId,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(organizationFileObjects.status, "reserved"),
              isNotNull(organizationFileObjects.writeId),
              lte(
                organizationFileObjects.reservationStartedAt,
                sql`${staleBefore}::timestamptz`,
              ),
              lte(
                organizationFileObjects.updatedAt,
                sql`${retryBefore}::timestamptz`,
              ),
              organizationId === undefined
                ? undefined
                : eq(organizationFileObjects.organizationId, organizationId),
            ),
          )
          .orderBy(
            asc(organizationFileObjects.updatedAt),
            asc(organizationFileObjects.objectKey),
          )
          .limit(limit),
    );
    let committed = 0;
    let deleted = 0;
    let released = 0;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const recoveryWriteId = Bun.randomUUIDv7();
      const claim = await db.transaction(async (tx) => {
        await tx
          .select({ organizationId: organizationFileUsage.organizationId })
          .from(organizationFileUsage)
          .where(
            eq(organizationFileUsage.organizationId, candidate.organizationId),
          )
          .for("update");
        const current = await tx
          .select({
            sizeBytes: organizationFileObjects.sizeBytes,
            reservationStartedAt: organizationFileObjects.reservationStartedAt,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(organizationFileObjects.objectKey, candidate.objectKey),
              eq(organizationFileObjects.status, "reserved"),
              eq(organizationFileObjects.writeId, candidate.writeId ?? ""),
              lte(
                organizationFileObjects.reservationStartedAt,
                sql`${staleBefore}::timestamptz`,
              ),
              lte(
                organizationFileObjects.updatedAt,
                sql`${retryBefore}::timestamptz`,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows.at(0));
        if (!current || !current.reservationStartedAt) {
          return null;
        }
        await tx
          .update(organizationFileObjects)
          .set({ writeId: recoveryWriteId, updatedAt: now })
          .where(eq(organizationFileObjects.objectKey, candidate.objectKey));
        return {
          ...current,
          reservationStartedAt: current.reservationStartedAt,
          referenced: await isDurablyReferenced(
            tx,
            candidate.organizationId,
            candidate.objectKey,
          ),
        };
      });
      if (!claim) {
        continue;
      }
      const reservation = {
        status: "reserved" as const,
        organizationId: candidate.organizationId,
        objectKey: candidate.objectKey,
        writeId: recoveryWriteId,
      };
      const { headObject } = await import("@/api/lib/s3-presign");
      const head = await headObject(candidate.objectKey);
      if (Result.isError(head)) {
        const { isMissingS3ObjectError } = await import("@/api/lib/s3");
        if (!isMissingS3ObjectError(head.error.cause)) {
          return yield* Result.err(head.error);
        }
        const settled = await releaseOrganizationFileBytes(reservation, db);
        yield* settled;
        released += 1;
        continue;
      }
      if (claim.referenced) {
        if (
          head.value.contentLength !== Number(claim.sizeBytes) ||
          head.value.lastModified === null ||
          head.value.lastModified.getTime() + S3_LAST_MODIFIED_PRECISION_MS <
            claim.reservationStartedAt.getTime()
        ) {
          return yield* Result.err(
            new OrganizationFileUsageError({
              message: "Referenced file does not match its reservation",
              reason: "storage_unavailable",
            }),
          );
        }
        const settled = await commitOrganizationFileBytes(reservation, db);
        yield* settled;
        committed += 1;
        continue;
      }
      const { deleteS3ObjectWithSignal } = await import("@/api/lib/s3");
      await deleteS3ObjectWithSignal(
        candidate.objectKey,
        signal ?? AbortSignal.timeout(30_000),
        { fileUsageDb: db },
      );
      const settled = await releaseOrganizationFileBytes(reservation, db);
      yield* settled;
      deleted += 1;
    }
    return Result.ok({
      scanned: candidates.length,
      committed,
      deleted,
      released,
    });
  });

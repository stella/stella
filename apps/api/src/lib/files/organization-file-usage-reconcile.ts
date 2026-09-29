import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";

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
  commitOrganizationFilesBytes,
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
  releaseOrganizationFilesBytes,
} from "@/api/lib/files/organization-file-usage";
import type { HeadObjectResult } from "@/api/lib/s3-presign";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export const ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT = 50;
const RETRY_DELAY_MS = 5 * 60_000;
const HASH_READ_TIMEOUT_MS = 5 * 60_000;
const UUID_KEY_PART = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const S3_LAST_MODIFIED_PRECISION_MS = 1000;
const unsettledObject = or(
  eq(organizationFileObjects.status, "reserved"),
  and(
    eq(organizationFileObjects.status, "committed"),
    isNotNull(organizationFileObjects.pendingSizeBytes),
  ),
);

type ReconcileOptions = {
  db: Pick<MaintenanceDb, "transaction">;
  organizationId?: SafeId<"organization">;
  limit?: number;
  signal?: AbortSignal;
};

/** A row is durable only when the key, or its exact minted object ID, is named by a persisted owner. */
const durableReferenceExpression = (
  organizationId: SafeId<"organization">,
  objectKey: string,
) => {
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
  return sql<boolean>`
    COALESCE(
      (SELECT TRUE FROM ${userFiles}
        INNER JOIN ${chatThreads} ON ${chatThreads.id} = ${userFiles.threadId}
        WHERE ${chatThreads.organizationId} = ${organizationId}
          AND ${userFiles.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${templates} WHERE ${templates.organizationId} = ${organizationId} AND ${templates.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${templateVersions} WHERE ${templateVersions.organizationId} = ${organizationId} AND ${templateVersions.s3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${styleSets} WHERE ${styleSets.organizationId} = ${organizationId} AND ${styleSets.s3Key} = ${objectKey} AND ${styleSets.deletedAt} IS NULL LIMIT 1),
      (SELECT TRUE FROM ${reportExports}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${reportExports.workspaceId}
        WHERE ${workspaces.organizationId} = ${organizationId}
          AND ${reportExports.resultS3Key} = ${objectKey} LIMIT 1),
      (SELECT TRUE FROM ${userFiles}
        INNER JOIN ${chatThreads} ON ${chatThreads.id} = ${userFiles.threadId}
        WHERE ${chatThreads.organizationId} = ${organizationId}
          AND ${userFiles.userId} = ${thumbnailUserId}
          AND ${userFiles.thumbnailFileId} = ${fileId} LIMIT 1),
      (SELECT TRUE FROM ${fields}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${fields.workspaceId}
        WHERE ${fields.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces.organizationId} = ${organizationId}
          AND ${fields.content}->>'type' = 'file'
          AND (${fields.content}->>'id' = ${uuidFileId}
            OR ${fields.content}->>'pdfFileId' = ${uuidFileId}
            OR ${fields.content}->>'thumbnailFileId' = ${uuidFileId}) LIMIT 1),
      (SELECT TRUE FROM ${desktopEditSessions}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${desktopEditSessions.workspaceId}
        WHERE ${desktopEditSessions.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces.organizationId} = ${organizationId}
          AND ${desktopEditSessions.checkpointFileId} = ${uuidFileId}::uuid
          AND ${desktopEditSessions.checkpointSizeBytes} IS NOT NULL LIMIT 1),
      (SELECT TRUE FROM ${folioCollabRooms}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${folioCollabRooms.workspaceId}
        WHERE ${folioCollabRooms.workspaceId} = ${workspaceId}::uuid
          AND ${workspaces.organizationId} = ${organizationId}
          AND ((${folioCollabRooms.yjsSnapshotFileId} = ${uuidFileId}::uuid AND ${folioCollabRooms.yjsSnapshotSizeBytes} IS NOT NULL)
            OR (${folioCollabRooms.docxCheckpointFileId} = ${uuidFileId}::uuid AND ${folioCollabRooms.docxCheckpointSizeBytes} IS NOT NULL)) LIMIT 1),
      (SELECT TRUE FROM ${documentProcessingRuns}
        WHERE ${documentProcessingRuns.organizationId} = ${organizationId}
          AND ${documentProcessingRuns.id} = ${ocrRunId}::uuid LIMIT 1),
      FALSE
    )
  `;
};

type ReferencedReservationMatchOptions = {
  expectedSha256Hex: string | null;
  head: HeadObjectResult;
  objectKey: string;
  pendingSizeBytes: bigint | null;
  reservationStartedAt: Date;
  signal: AbortSignal | undefined;
  sizeBytes: bigint;
};

const matchesReferencedReservation = async ({
  expectedSha256Hex,
  head,
  objectKey,
  pendingSizeBytes,
  reservationStartedAt,
  signal,
  sizeBytes,
}: ReferencedReservationMatchOptions) => {
  if (
    head.contentLength !== Number(pendingSizeBytes ?? sizeBytes) ||
    (expectedSha256Hex === null &&
      (head.lastModified === null ||
        head.lastModified.getTime() + S3_LAST_MODIFIED_PRECISION_MS <
          reservationStartedAt.getTime()))
  ) {
    return Result.ok(false);
  }
  if (expectedSha256Hex === null) {
    return Result.ok(true);
  }
  if (head.checksumSHA256 !== null) {
    return Result.ok(
      Buffer.from(head.checksumSHA256, "base64").toString("hex") ===
        expectedSha256Hex,
    );
  }
  const { hashS3ObjectSha256WithSignal } = await import("@/api/lib/s3");
  const read = await Result.tryPromise({
    try: async () =>
      await hashS3ObjectSha256WithSignal(
        objectKey,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(HASH_READ_TIMEOUT_MS)])
          : AbortSignal.timeout(HASH_READ_TIMEOUT_MS),
      ),
    catch: (cause) =>
      new OrganizationFileUsageError({
        message: "Referenced file could not be verified",
        reason: "storage_unavailable",
        cause,
      }),
  });
  return Result.isError(read)
    ? Result.err(read.error)
    : Result.ok(read.value === expectedSha256Hex);
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
              unsettledObject,
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
    const { headObject } = await import("@/api/lib/s3-presign");
    const { deleteS3ObjectWithSignal, isMissingS3ObjectError } =
      await import("@/api/lib/s3");
    const recoveryWriteId = Bun.randomUUIDv7();
    const claims =
      candidates.length === 0
        ? []
        : await db.transaction(async (tx) => {
            await tx
              .select({ organizationId: organizationFileUsage.organizationId })
              .from(organizationFileUsage)
              .where(
                inArray(organizationFileUsage.organizationId, [
                  ...new Set(
                    candidates.map((candidate) => candidate.organizationId),
                  ),
                ]),
              )
              .orderBy(asc(organizationFileUsage.organizationId))
              .limit(candidates.length)
              .for("update");
            const current = await tx
              .select({
                objectKey: organizationFileObjects.objectKey,
                organizationId: organizationFileObjects.organizationId,
                status: organizationFileObjects.status,
                sizeBytes: organizationFileObjects.sizeBytes,
                pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
                expectedSha256Hex: organizationFileObjects.expectedSha256Hex,
                reservationStartedAt:
                  organizationFileObjects.reservationStartedAt,
                referenced: sql<boolean>`${sqlCaseFragment({
                  branches: candidates.map(
                    (candidate) =>
                      sql`WHEN ${organizationFileObjects.objectKey} = ${candidate.objectKey} THEN ${durableReferenceExpression(candidate.organizationId, candidate.objectKey)}`,
                  ),
                  fallback: sql`FALSE`,
                })}`,
              })
              .from(organizationFileObjects)
              .where(
                and(
                  unsettledObject,
                  or(
                    ...candidates.map((candidate) =>
                      and(
                        eq(
                          organizationFileObjects.objectKey,
                          candidate.objectKey,
                        ),
                        eq(
                          organizationFileObjects.writeId,
                          candidate.writeId ?? "",
                        ),
                      ),
                    ),
                  ),
                  lte(
                    organizationFileObjects.reservationStartedAt,
                    sql`${staleBefore}::timestamptz`,
                  ),
                  lte(
                    organizationFileObjects.updatedAt,
                    sql`${retryBefore}::timestamptz`,
                  ),
                ),
              );
            if (current.length !== 0) {
              await tx
                .update(organizationFileObjects)
                .set({ writeId: recoveryWriteId, updatedAt: now })
                .where(
                  inArray(
                    organizationFileObjects.objectKey,
                    current.map((row) => row.objectKey),
                  ),
                );
            }
            return current;
          });
    const toCommit = [];
    const toRelease = [];
    let committed = 0;
    let deleted = 0;
    let released = 0;
    let mismatched = 0;
    for (const claim of claims) {
      signal?.throwIfAborted();
      if (!claim.reservationStartedAt) {
        panic("Claimed reservation has no start time");
      }
      const candidate = claim;
      const reservation = {
        status: "reserved" as const,
        organizationId: candidate.organizationId,
        objectKey: candidate.objectKey,
        writeId: recoveryWriteId,
      };
      const head = await headObject(candidate.objectKey);
      if (Result.isError(head)) {
        if (!isMissingS3ObjectError(head.error.cause)) {
          return yield* Result.err(head.error);
        }
        toRelease.push(reservation);
        released += 1;
        continue;
      }
      if (claim.status === "committed" || claim.referenced) {
        const matches = await matchesReferencedReservation({
          expectedSha256Hex: claim.expectedSha256Hex,
          head: head.value,
          objectKey: candidate.objectKey,
          pendingSizeBytes: claim.pendingSizeBytes,
          reservationStartedAt: claim.reservationStartedAt,
          signal,
          sizeBytes: claim.sizeBytes,
        });
        if (!(yield* matches)) {
          mismatched += 1;
          continue;
        }
        toCommit.push(reservation);
        committed += 1;
        continue;
      }
      await deleteS3ObjectWithSignal(
        candidate.objectKey,
        signal ?? AbortSignal.timeout(30_000),
      );
      toRelease.push(reservation);
      deleted += 1;
    }
    yield* await commitOrganizationFilesBytes(toCommit, db);
    yield* await releaseOrganizationFilesBytes(toRelease, db);
    return Result.ok({
      scanned: candidates.length,
      committed,
      deleted,
      released,
      mismatched,
    });
  });

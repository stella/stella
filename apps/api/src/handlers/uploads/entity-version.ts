/** Presigned-upload transport for creating a new entity file version. */
import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  PendingUploadFinalizedResult,
  PendingUploadPurposeData,
} from "@/api/db/schema";
import { pendingUploads } from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { writeFileVersion } from "@/api/handlers/entities/write-file-version";
import { allocateFileObject } from "@/api/handlers/files/file-object-ids";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { UPLOAD_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";

import { finalizeErr, finalizeOk } from "./lib";
import type { UploadFinalizeError } from "./lib";

export type ValidateEntityVersionProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

/**
 * Refuse to mint a presigned URL for an invalid or read-only target.
 *
 * @yields Safe database errors to the parent safe handler.
 */
export const validateEntityVersion = async function* ({
  safeDb,
  workspaceId,
  entityId,
}: ValidateEntityVersionProps) {
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: entityId },
          workspaceId: { eq: workspaceId },
        },
        columns: { currentVersionId: true, readOnly: true },
      }),
    ),
  );
  if (!entity?.currentVersionId) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }
  if (entity.readOnly) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }
  return Result.ok(undefined);
};

export type FinalizeEntityVersionProps = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  fileBuffer: ArrayBuffer;
  declaredName: string;
  declaredMime: string;
  declaredSize: number;
  declaredSha256Hex: string;
  purposeData: Extract<PendingUploadPurposeData, { type: "entity_version" }>;
  scanWarnings: string[] | undefined;
  uploadId: SafeId<"pendingUpload">;
  claimRequestId: string;
  promoteTmpObject: (
    finalKey: string,
  ) => Promise<Result<void, UploadFinalizeError>>;
};

/**
 * Promote the staged object, then join the canonical version transaction. The
 * pending-upload FSM transition is supplied as writeFileVersion's afterWrite
 * hook so it commits atomically with the entity/version audit rows.
 *
 * @yields Safe database errors to the parent finalize handler.
 */
export const finalizeEntityVersion = async function* ({
  safeDb,
  recordAuditEvent,
  organizationId,
  workspaceId,
  userId,
  fileBuffer: _fileBuffer,
  declaredName,
  declaredMime,
  declaredSize,
  declaredSha256Hex,
  purposeData,
  scanWarnings,
  uploadId,
  claimRequestId,
  promoteTmpObject,
}: FinalizeEntityVersionProps) {
  const fileName = sanitizeFilename(declaredName);
  const { entityId } = purposeData;
  const fileId = allocateFileObject();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const finalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: declaredMime,
  });

  const promoted = await promoteTmpObject(finalKey);
  if (Result.isError(promoted)) {
    return promoted;
  }

  const cleanupFinalObject = async (stage: string) => {
    await getS3()
      .delete(finalKey)
      .catch((error: unknown) =>
        captureError(error, { entityId, fieldId, stage }),
      );
  };

  let finalized:
    | Extract<PendingUploadFinalizedResult, { type: "entity_version" }>
    | undefined;
  const writeResultResult = await safeDb(
    async (tx) =>
      await writeFileVersion({
        tx,
        workspaceId,
        entityId,
        userId,
        recordAuditEvent,
        entityVersionId,
        fieldId,
        fileId,
        fileName,
        mimeType: declaredMime,
        sizeBytes: declaredSize,
        sha256Hex: declaredSha256Hex,
        source: UPLOAD_DOCUMENT_SOURCE,
        scanWarnings,
        afterWrite: async ({ versionNumber }) => {
          finalized = {
            type: "entity_version",
            entityId,
            entityVersionId,
            versionNumber,
            fileId,
            fileName,
          };
          // audit: skip — FSM bookkeeping; entity/version events are recorded
          // by writeFileVersion in this same transaction.
          const rows = await tx
            .update(pendingUploads)
            .set({
              status: "finalized",
              finalizedResult: finalized,
              finalizedAt: new Date(),
            })
            .where(
              and(
                eq(pendingUploads.id, uploadId),
                eq(pendingUploads.userId, userId),
                eq(pendingUploads.workspaceId, workspaceId),
                eq(pendingUploads.status, "scanning"),
                eq(pendingUploads.claimedByRequestId, claimRequestId),
              ),
            )
            .returning({ id: pendingUploads.id });
          if (!rows.at(0)) {
            panic("Pending upload finalize marker update returned no rows");
          }
        },
      }),
  );
  if (Result.isError(writeResultResult)) {
    await cleanupFinalObject("final-cleanup-after-db-error");
  }
  const writeResult = yield* writeResultResult;

  if (writeResult.status !== "ok") {
    await cleanupFinalObject("final-cleanup-after-business-error");
    if (
      writeResult.status === "entity-not-found" ||
      writeResult.status === "current-version-not-found"
    ) {
      return finalizeErr({
        status: 404,
        message:
          writeResult.status === "entity-not-found"
            ? "Entity not found"
            : "Current version not found",
        rejectReason: writeResult.status,
      });
    }
    if (writeResult.status === "entity-read-only") {
      return finalizeErr({
        status: 409,
        message: "Entity is read-only",
        rejectReason: writeResult.status,
      });
    }
    return finalizeErr({
      status: 400,
      message: "Entity has no file field",
      rejectReason: writeResult.status,
    });
  }

  const finalizedResult =
    finalized ??
    panic("Entity version write completed without finalize result");
  const afterPromote = () => {
    processExtraction(entityId).catch((error: unknown) => {
      captureError(error, { entityId });
    });
    enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId,
      mimeType: declaredMime,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, { entityId, fieldId, mimeType: declaredMime });
    });
    enqueueImageThumbnailOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId,
      mimeType: declaredMime,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, { entityId, fieldId, mimeType: declaredMime });
    });
    computeVersionDiffStats({
      versionId: entityVersionId,
      entityId,
      scopedDb: createRootScopedDb({
        organizationId,
        userId,
        workspaceIds: [workspaceId],
      }),
      workspaceId,
      organizationId,
    }).catch((error: unknown) => {
      captureError(error, { versionId: entityVersionId });
    });
    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });
  };

  return finalizeOk({ finalizedResult, finalKey, afterPromote });
};

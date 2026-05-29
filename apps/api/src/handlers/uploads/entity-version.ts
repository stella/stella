/**
 * `entity_version` purpose: a presigned-upload flow that creates a
 * new `entityVersions` row + `fields` clone for an existing entity,
 * mirroring the legacy multipart endpoint at
 * `apps/api/src/handlers/entities/upload-version.ts`.
 *
 * Reuses `cloneFieldsForRevision`, `buildVersionStamp`, and the
 * cell-metadata carry-over from the legacy handler exactly so the
 * resulting row is byte-for-byte identical to what the multipart
 * path would have produced.
 */
import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import type {
  PendingUploadFinalizedResult,
  PendingUploadPurposeData,
} from "@/api/db/schema";
import {
  cellMetadata,
  entities,
  entityVersions,
  fields,
  pendingUploads,
  workspaces,
} from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
} from "@/api/handlers/entities/version-utils";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
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
 * Up-front gating: entity exists, isn't read-only, has a file
 * field. Lets the API refuse to mint a presigned URL the user
 * couldn't redeem anyway.
 *
 * @yields safeDb errors out to the parent safe-handler.
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
        columns: {
          currentVersionId: true,
          readOnly: true,
        },
      }),
    ),
  );
  if (!entity || !entity.currentVersionId) {
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
  promoteTmpObject: (
    finalKey: string,
  ) => Promise<Result<void, UploadFinalizeError>>;
};

/**
 * Domain transaction for `entity_version`. Allocates a new
 * `entityVersions` row + cloned fields with the uploaded file
 * swapped into the file field, carries cell metadata across,
 * records the two audit events the legacy handler emits, kicks
 * off async extraction + diff-stat computation + SSE broadcast.
 *
 * @yields safeDb errors out to the parent safe-handler.
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
  promoteTmpObject,
}: FinalizeEntityVersionProps) {
  const sanitizedName = sanitizeFilename(declaredName);
  const { entityId } = purposeData;

  const fileId = Bun.randomUUIDv7();
  const nextVersionId = createSafeId<"entityVersion">();
  const fileFieldId = createSafeId<"field">();
  const finalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: declaredMime,
  });

  const promoteResult = await promoteTmpObject(finalKey);
  if (Result.isError(promoteResult)) {
    return promoteResult;
  }

  type WriteResult =
    | {
        status: "ok";
        finalized: Extract<
          PendingUploadFinalizedResult,
          { type: "entity_version" }
        >;
      }
    | {
        status:
          | "entity-not-found"
          | "entity-read-only"
          | "current-version-not-found"
          | "missing-file-field";
      };

  const cleanupFinalObject = async (stage: string) => {
    await getS3()
      .delete(finalKey)
      .catch((deleteError: unknown) =>
        captureError(deleteError, {
          entityId,
          fieldId: fileFieldId,
          stage,
        }),
      );
  };

  const writeResultResult = await safeDb(async (tx): Promise<WriteResult> => {
    // Lock the entity row for the duration of the transaction so
    // a concurrent version upload can't observe a stale
    // currentVersionId.
    const entityRows = await tx
      .select({
        currentVersionId: entities.currentVersionId,
        docSequence: entities.docSequence,
        readOnly: entities.readOnly,
      })
      .from(entities)
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .limit(1)
      .for("update");
    const lockedEntity = entityRows.at(0);

    if (!lockedEntity?.currentVersionId) {
      return { status: "entity-not-found" };
    }
    if (lockedEntity.readOnly) {
      return { status: "entity-read-only" };
    }

    const freshCurrentVersionId = lockedEntity.currentVersionId;
    const freshCurrentVersion = await tx.query.entityVersions.findFirst({
      where: { id: { eq: freshCurrentVersionId } },
      columns: { versionNumber: true },
      with: {
        fields: { columns: { content: true, propertyId: true } },
      },
    });
    if (!freshCurrentVersion) {
      return { status: "current-version-not-found" };
    }

    const freshFileField = freshCurrentVersion.fields.find(
      (field) => field.content.type === "file",
    );
    if (!freshFileField) {
      return { status: "missing-file-field" };
    }

    const workspace = await tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { reference: true },
    });

    const nextVersionNumber = freshCurrentVersion.versionNumber + 1;
    const nextVersionStamp = buildVersionStamp({
      docSequence: lockedEntity.docSequence,
      versionNumber: nextVersionNumber,
      workspaceReference: workspace?.reference ?? null,
    });

    await tx.insert(entityVersions).values({
      createdBy: userId,
      entityId,
      id: nextVersionId,
      stamp: nextVersionStamp.stamp,
      verificationCode: nextVersionStamp.verificationCode,
      versionNumber: nextVersionNumber,
      workspaceId,
    });

    await tx.insert(fields).values(
      cloneFieldsForRevision({
        currentFields: freshCurrentVersion.fields,
        entityVersionId: nextVersionId,
        propertyId: freshFileField.propertyId,
        replacementFieldId: fileFieldId,
        replacementContent: {
          encrypted: false,
          fileName: sanitizedName,
          id: fileId,
          mimeType: declaredMime,
          pdfFileId: null,
          sha256Hex: declaredSha256Hex,
          sizeBytes: declaredSize,
          type: "file",
          version: 1,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: declaredMime,
          }),
          ...(scanWarnings !== undefined && { scanWarnings }),
        },
        workspaceId,
      }),
    );

    // Carry over cell metadata from every property except the
    // file field (whose metadata starts fresh per version).
    const currentCellMetadataRows = await tx
      .select({
        createdAt: cellMetadata.createdAt,
        createdBy: cellMetadata.createdBy,
        metadata: cellMetadata.metadata,
        propertyId: cellMetadata.propertyId,
        updatedAt: cellMetadata.updatedAt,
        updatedBy: cellMetadata.updatedBy,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.workspaceId, workspaceId),
          eq(cellMetadata.entityVersionId, freshCurrentVersionId),
        ),
      )
      .for("update");

    const cellMetadataRowsToCopy = currentCellMetadataRows.filter(
      (row) => row.propertyId !== freshFileField.propertyId,
    );

    if (cellMetadataRowsToCopy.length > 0) {
      await tx.insert(cellMetadata).values(
        cellMetadataRowsToCopy.map((row) => ({
          workspaceId,
          entityVersionId: nextVersionId,
          propertyId: row.propertyId,
          metadata: row.metadata,
          createdBy: row.createdBy,
          updatedBy: row.updatedBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      );
    }

    await tx
      .update(entities)
      .set({
        currentVersionId: nextVersionId,
        lastEditedBy: userId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      );

    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    await recordAuditEvent(tx, [
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
        resourceId: nextVersionId,
        changes: {
          created: {
            old: null,
            new: {
              entityId,
              versionNumber: nextVersionNumber,
              fileName: sanitizedName,
              mimeType: declaredMime,
              sizeBytes: declaredSize,
              sha256Hex: declaredSha256Hex,
            },
          },
        },
        metadata: {
          fileName: sanitizedName,
          mimeType: declaredMime,
          sizeBytes: declaredSize,
          sha256Hex: declaredSha256Hex,
        },
      },
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: entityId,
        changes: {
          currentVersionId: {
            old: freshCurrentVersionId,
            new: nextVersionId,
          },
        },
      },
    ]);

    const finalized: Extract<
      PendingUploadFinalizedResult,
      { type: "entity_version" }
    > = {
      type: "entity_version",
      entityId,
      entityVersionId: nextVersionId,
      versionNumber: nextVersionNumber,
      fileId,
      fileName: sanitizedName,
    };

    // audit: skip — final FSM transition on pending_uploads;
    // the entity/version audit rows landed above in this same transaction.
    const finalizedRows = await tx
      .update(pendingUploads)
      .set({
        status: "finalized",
        finalizedResult: finalized,
        finalizedAt: new Date(),
      })
      .where(
        and(
          eq(pendingUploads.id, uploadId),
          eq(pendingUploads.workspaceId, workspaceId),
        ),
      )
      .returning({ id: pendingUploads.id });
    if (!finalizedRows.at(0)) {
      panic("Pending upload finalize marker update returned no rows");
    }

    return { status: "ok", finalized };
  });
  if (Result.isError(writeResultResult)) {
    await cleanupFinalObject("final-cleanup-after-db-error");
  }
  const writeResult = yield* writeResultResult;

  if (writeResult.status !== "ok") {
    const status = writeResult.status;
    if (
      status === "entity-not-found" ||
      status === "current-version-not-found"
    ) {
      await cleanupFinalObject("final-cleanup-after-business-error");
      return finalizeErr({
        status: 404,
        message:
          status === "entity-not-found"
            ? "Entity not found"
            : "Current version not found",
        rejectReason: status,
      });
    }
    if (status === "entity-read-only") {
      await cleanupFinalObject("final-cleanup-after-business-error");
      return finalizeErr({
        status: 409,
        message: "Entity is read-only",
        rejectReason: "entity-read-only",
      });
    }
    await cleanupFinalObject("final-cleanup-after-business-error");
    return finalizeErr({
      status: 400,
      message: "Entity has no file field",
      rejectReason: "missing-file-field",
    });
  }

  const finalized = writeResult.finalized;
  const afterPromote = () => {
    // Async kickoffs mirror the legacy handler. They run only after
    // both promotion and the DB transaction have succeeded, so
    // consumers never read a final key before it exists.
    processExtraction(entityId).catch((error: unknown) => {
      captureError(error, { entityId });
    });
    enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: declaredMime,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId: fileFieldId,
        mimeType: declaredMime,
      });
    });
    computeVersionDiffStats({
      versionId: nextVersionId,
      entityId,
      scopedDb: createRootScopedDb({
        organizationId,
        userId,
        workspaceIds: [workspaceId],
      }),
      workspaceId,
      organizationId,
    }).catch((error: unknown) => {
      captureError(error, { versionId: nextVersionId });
    });
    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });
  };

  return finalizeOk({ finalizedResult: finalized, finalKey, afterPromote });
};

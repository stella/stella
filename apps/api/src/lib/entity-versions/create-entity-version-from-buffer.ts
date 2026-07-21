/**
 * Write a new entity version from an already-built DOCX buffer -- the
 * write-back half of `loadEntityVersionDocxBuffer`. Mirrors
 * `upload-version.ts`'s S3-write -> locked-transaction -> fire-and-forget
 * pattern, generalized for a caller that already has bytes in hand (an
 * AI-transformed buffer) rather than an uploaded `File`.
 *
 * Used today only by `edit_workspace_document` (`edit-workspace-document-
 * tools.ts`). `upload-version.ts`, `folio-collab`'s finalize handler, and
 * `finalize-desktop-edit-session.ts` implement the same new-version pattern
 * inline; they are NOT refactored onto this helper in this change.
 * TODO: fold those three call sites onto this helper once it has a second
 * caller confirming the abstraction holds.
 */

import { Result, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  cellMetadata,
  entities,
  entityVersions,
  fields,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
  nextEntityVersionNumber,
} from "@/api/handlers/entities/version-utils";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { createFileKey } from "@/api/handlers/files/utils";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { detached } from "@/api/lib/detached";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type CreateEntityVersionFromBufferOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  /** The already-transformed DOCX bytes to write as the new version. */
  buffer: ArrayBuffer;
  /** Preserved verbatim from the version being replaced. */
  fileName: string;
  /** The file property to replace; every other field is cloned as-is. */
  filePropertyId: SafeId<"property">;
  currentFields: { content: FieldContent; propertyId: SafeId<"property"> }[];
};

export type CreateEntityVersionFromBufferSuccess = {
  entityVersionId: SafeId<"entityVersion">;
  versionNumber: number;
  fieldId: SafeId<"field">;
};

type CreateEntityVersionFromBufferFailureReason =
  | "entityNotFound"
  | "entityReadOnly"
  | "currentVersionNotFound";

const FAILURE_REASON_MESSAGES: Record<
  CreateEntityVersionFromBufferFailureReason,
  string
> = {
  entityNotFound: "Document not found",
  entityReadOnly: "Document is read-only",
  currentVersionNotFound: "Current document version not found",
};

export class CreateEntityVersionFromBufferError extends TaggedError(
  "CreateEntityVersionFromBufferError",
)<{
  message: string;
  reason: CreateEntityVersionFromBufferFailureReason;
}>() {}

type WriteTxResult =
  | { status: "ok"; versionNumber: number }
  | { status: CreateEntityVersionFromBufferFailureReason };

/**
 * Write `buffer` as a new version of `entityId`, replacing the file field
 * at `filePropertyId` and carrying every other field forward
 * (`cloneFieldsForRevision`). Validates the entity isn't read-only under a
 * `FOR UPDATE` lock (same TOCTOU guard `upload-version.ts` applies), and
 * cleans up the just-written S3 object on any failure path so a rejected
 * write never orphans bytes.
 *
 * Extraction, PDF/thumbnail derivatives, and diff-stat computation run
 * detached (fire-and-forget, captured via `detached()`) after the
 * transaction commits, matching `upload-version.ts`.
 */
export const createEntityVersionFromBuffer = async ({
  safeDb,
  organizationId,
  workspaceId,
  entityId,
  userId,
  recordAuditEvent,
  buffer,
  fileName,
  filePropertyId,
  currentFields,
}: CreateEntityVersionFromBufferOptions): Promise<
  Result<
    CreateEntityVersionFromBufferSuccess,
    CreateEntityVersionFromBufferError | SafeDbError
  >
> => {
  const bytes = new Uint8Array(buffer);
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const fileId = allocateFileObject();
  const s3Key = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: DOCX_MIME_TYPE,
  });
  const nextVersionId = createSafeId<"entityVersion">();
  const fileFieldId = createSafeId<"field">();

  await getS3().write(s3Key, bytes);

  const writeResult = await safeDb(async (tx): Promise<WriteTxResult> => {
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
      return { status: "entityNotFound" };
    }
    if (lockedEntity.readOnly) {
      return { status: "entityReadOnly" };
    }

    const freshCurrentVersionId = lockedEntity.currentVersionId;
    const freshCurrentVersion = await tx.query.entityVersions.findFirst({
      where: { id: { eq: freshCurrentVersionId } },
      columns: { id: true },
    });
    if (!freshCurrentVersion) {
      return { status: "currentVersionNotFound" };
    }

    const workspace = await tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { reference: true },
    });

    // MAX over all versions (incl. tombstoned) under the entity lock, not
    // currentVersion + 1 -- see nextEntityVersionNumber's own doc comment.
    const nextVersionNumber = await nextEntityVersionNumber(tx, {
      entityId,
      workspaceId,
    });
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
        currentFields,
        entityVersionId: nextVersionId,
        propertyId: filePropertyId,
        replacementFieldId: fileFieldId,
        replacementContent: fileContentWithMintedObject({
          encrypted: false,
          fileName,
          id: fileId,
          mimeType: DOCX_MIME_TYPE,
          pdfFileId: null,
          sha256Hex,
          sizeBytes: bytes.byteLength,
          type: "file",
          version: 1,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
          thumbnailFileId: null,
          thumbnailDerivative: thumbnailDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
        }),
        workspaceId,
      }),
    );

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
      (row) => row.propertyId !== filePropertyId,
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
              fileName,
              mimeType: DOCX_MIME_TYPE,
              sizeBytes: bytes.byteLength,
              sha256Hex,
            },
          },
        },
        metadata: {
          fileName,
          mimeType: DOCX_MIME_TYPE,
          sizeBytes: bytes.byteLength,
          sha256Hex,
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

    return { status: "ok", versionNumber: nextVersionNumber };
  });

  if (Result.isError(writeResult)) {
    detached(getS3().delete(s3Key), "edit-workspace-document.s3-cleanup");
    return Result.err(writeResult.error);
  }
  if (writeResult.value.status !== "ok") {
    const reason = writeResult.value.status;
    detached(getS3().delete(s3Key), "edit-workspace-document.s3-cleanup");
    return Result.err(
      new CreateEntityVersionFromBufferError({
        message: FAILURE_REASON_MESSAGES[reason],
        reason,
      }),
    );
  }

  const versionNumber = writeResult.value.versionNumber;

  detached(
    processExtraction(entityId),
    "edit-workspace-document.process-extraction",
  );
  detached(
    enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      userId,
      workspaceId,
    }),
    "edit-workspace-document.pdf-derivative",
  );
  detached(
    enqueueImageThumbnailOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      userId,
      workspaceId,
    }),
    "edit-workspace-document.thumbnail-derivative",
  );
  detached(
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
    }),
    "edit-workspace-document.diff-stats",
  );

  broadcast(workspaceId, {
    type: "invalidate-query",
    data: ["entities", workspaceId],
  });

  return Result.ok({
    entityVersionId: nextVersionId,
    versionNumber,
    fieldId: fileFieldId,
  });
};

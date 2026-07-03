import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import { validateParentIdForInsert } from "@/api/handlers/entities/validate-parent-id";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";

type CreateEntityFromBufferInput = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  buffer: Uint8Array | ArrayBuffer;
  fileName: string;
  mimeType: string;
  parentId?: SafeId<"entity"> | null | undefined;
  scanWarnings?: string[] | undefined;
};

class EntityLimitError extends TaggedError("EntityLimitError")<{
  message: string;
}>() {}

class MissingFilePropertyError extends TaggedError("MissingFilePropertyError")<{
  message: string;
}>() {}

class InvalidParentError extends TaggedError("InvalidParentError")<{
  message: string;
}>() {}

export type CreateEntityFromBufferResult = Result<
  {
    entityId: SafeId<"entity">;
    fieldId: SafeId<"field">;
    fileName: string;
  },
  EntityLimitError | InvalidParentError | MissingFilePropertyError
>;

/**
 * Create a new entity from a raw file buffer. Handles S3
 * upload, Gotenberg PDF conversion, DB entity creation,
 * and triggers search extraction.
 *
 * Shared between the upload handler and AI chat tools.
 */
export const createEntityFromBuffer = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  buffer,
  fileName: rawFileName,
  mimeType,
  parentId,
  scanWarnings,
}: CreateEntityFromBufferInput): Promise<CreateEntityFromBufferResult> => {
  const fileName = sanitizeFilenamePreservingExtension(rawFileName);
  const fileId = allocateFileObject();
  const s3Key = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  // Check for file property before uploading to avoid
  // orphaned S3 files if the property doesn't exist.
  const wsProperties = await scopedDb((tx) =>
    tx.query.properties.findMany({
      columns: { id: true, content: true },
      where: { workspaceId: { eq: workspaceId } },
      limit: LIMITS.propertiesCount,
    }),
  );
  const fileProperty = wsProperties.find((p) => p.content.type === "file");

  if (!fileProperty) {
    return Result.err(
      new MissingFilePropertyError({
        message: "No file property found",
      }),
    );
  }

  // Track S3 keys for cleanup before any uploads.
  const s3Keys = [s3Key];

  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();

  try {
    await getS3().write(s3Key, bytes);

    await scopedDb(async (tx) => {
      // See `lockWorkspacesForEntityCap` for the canonical lock
      // order every entity-creating path follows (issue #1139).
      await lockWorkspacesForEntityCap(tx, [workspaceId]);

      // The authoritative limit check must stay in the same
      // transaction as the insert, behind the lock above, to avoid
      // TOCTOU races.
      const entityCount = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );
      if (entityCount >= LIMITS.entitiesCount) {
        throw new EntityLimitError({
          message: "Entities limit reached",
        });
      }

      // The earlier parent lookup is only a fail-fast preflight. Recheck and
      // lock the row here so it cannot disappear between validation and insert.
      if (parentId) {
        const parentError = await validateParentIdForInsert({
          tx,
          parentId,
          workspaceId,
        });
        if (parentError) {
          throw new InvalidParentError({ message: parentError });
        }
      }

      const entityStamp = await allocateEntityStamp(tx, workspaceId);

      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        name: fileName,
        parentId: parentId ?? null,
        createdBy: userId,
        docSequence: entityStamp.docSequence,
      });

      await tx.insert(entityVersions).values({
        id: entityVersionId,
        workspaceId,
        entityId,
        versionNumber: 1,
        stamp: entityStamp.stamp,
        verificationCode: entityStamp.verificationCode,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      await tx.insert(fields).values({
        id: fieldId,
        workspaceId,
        propertyId: fileProperty.id,
        entityVersionId,
        content: fileContentWithMintedObject({
          type: "file",
          version: 1,
          id: fileId,
          fileName,
          mimeType,
          sizeBytes: bytes.byteLength,
          encrypted: false,
          sha256Hex,
          pdfFileId: null,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType,
          }),
          thumbnailFileId: null,
          thumbnailDerivative: thumbnailDerivativeStateForFile({
            encrypted: false,
            mimeType,
          }),
          ...(scanWarnings !== undefined && { scanWarnings }),
        }),
      });

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: entityId,
        changes: {
          created: {
            old: null,
            new: {
              kind: "document",
              fileName,
              mimeType,
              sizeBytes: bytes.byteLength,
              propertyId: fileProperty.id,
              parentId: parentId ?? null,
            },
          },
        },
      });
    });
  } catch (error) {
    await Promise.all(s3Keys.map(async (k) => await getS3().delete(k)));

    if (EntityLimitError.is(error) || InvalidParentError.is(error)) {
      return Result.err(error);
    }

    throw error;
  }

  // LOOP-GUARD INVARIANT: this is the server-side entity-creation path (flow
  // `create-document` step, template fill, translation, legal-source import). It
  // must NOT invoke `maybeStartUploadTriggeredFlows` — only genuine USER uploads
  // fire the file-upload trigger, so a flow-created document can never spawn
  // another flow run. Keep the upload trigger out of this call site.
  processExtraction(entityId).catch(captureError);

  enqueuePdfDerivativeOrMarkFailed({
    encrypted: false,
    entityId,
    fieldId,
    mimeType,
    organizationId,
    userId,
    workspaceId,
  }).catch(captureError);

  enqueueImageThumbnailOrMarkFailed({
    encrypted: false,
    entityId,
    fieldId,
    mimeType,
    organizationId,
    userId,
    workspaceId,
  }).catch(captureError);

  return Result.ok({ entityId, fieldId, fileName });
};

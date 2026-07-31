import { Result, TaggedError, panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  entities,
  entityVersions,
  fields,
  pendingUploads,
  PENDING_UPLOAD_RECOVERABLE_STATUSES,
  workspaces,
} from "@/api/db/schema";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
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
import {
  BUFFER_INTENT_DELETE_TIMEOUT_MS,
  BUFFER_INTENT_HEARTBEAT_MS,
  BUFFER_INTENT_TTL_MS,
  BUFFER_INTENT_WRITE_TIMEOUT_MS,
  lockActiveWorkspaceForBufferIntent,
} from "@/api/lib/buffer-intent-reconciliation";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { deleteS3ObjectWithSignal, putS3ObjectWithSignal } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { withTimeout } from "@/api/lib/with-timeout";

type BufferEntityCreateIntent = {
  claimRequestId: string;
  id: SafeId<"pendingUpload">;
};

const toSafeDb =
  (scopedDb: ScopedDb): SafeDb =>
  async <T>(run: (tx: Transaction) => Promise<T>) =>
    await Result.tryPromise(async () => await scopedDb(run));

const reserveEntityCreateIntent = async ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  propertyId,
  fileId,
  fileName,
  mimeType,
  sizeBytes,
  sha256Hex,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  propertyId: SafeId<"property">;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
}): Promise<BufferEntityCreateIntent> => {
  const id = createSafeId<"pendingUpload">();
  const claimRequestId = Bun.randomUUIDv7().slice(0, 64);
  const now = new Date();
  const reserved = await safeDb(async (tx) => {
    await lockActiveWorkspaceForBufferIntent(tx, workspaceId);
    // audit: skip — crash-recovery intent; entity creation is audited later.
    const rows = await tx
      .insert(pendingUploads)
      .values({
        id,
        organizationId,
        workspaceId,
        userId,
        purpose: "entity_create",
        purposeData: {
          type: "entity_create",
          propertyId,
          reservedFileId: fileId,
        },
        declaredName: fileName,
        declaredMime: mimeType,
        declaredSize: sizeBytes,
        declaredSha256: sha256Hex,
        status: "scanning",
        claimedAt: now,
        claimedByRequestId: claimRequestId,
        expiresAt: new Date(now.getTime() + BUFFER_INTENT_TTL_MS),
        createdAt: now,
      })
      .returning({ id: pendingUploads.id });
    return (
      rows.at(0)?.id ?? panic("Entity buffer intent insert returned no row")
    );
  });
  if (Result.isError(reserved)) {
    throw reserved.error;
  }
  return { id: reserved.value, claimRequestId };
};

const abandonEntityCreateIntent = async ({
  safeDb,
  intent,
  reason,
}: {
  safeDb: SafeDb;
  intent: BufferEntityCreateIntent;
  reason: string;
}): Promise<void> => {
  const abandoned = await safeDb(async (tx) => {
    // audit: skip — failed intent bookkeeping; no durable entity was created.
    // The writer reaches this only after its PUT settled and deletion of its
    // exact reserved key succeeded. It may therefore close a recoverable row
    // even when the reconciler replaced its expired lease in the meantime.
    await tx
      .update(pendingUploads)
      .set({
        finalizedAt: new Date(),
        rejectReason: reason,
        status: "rejected",
      })
      .where(
        and(
          eq(pendingUploads.id, intent.id),
          inArray(pendingUploads.status, PENDING_UPLOAD_RECOVERABLE_STATUSES),
        ),
      );
    await tx
      .delete(bufferObjectCleanupIntents)
      .where(eq(bufferObjectCleanupIntents.id, intent.id));
  });
  if (Result.isError(abandoned)) {
    captureError(abandoned.error, {
      pendingUploadId: intent.id,
      stage: "buffer-entity-intent-abandon",
    });
  }
};

const startEntityCreateIntentHeartbeat = ({
  safeDb,
  intent,
}: {
  safeDb: SafeDb;
  intent: BufferEntityCreateIntent;
}): (() => Promise<void>) => {
  let heartbeatPromise: Promise<void> | null = null;
  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    try {
      const renewed = await safeDb(async (tx) => {
        // audit: skip — live crash-recovery lease bookkeeping only.
        await tx
          .update(pendingUploads)
          .set({ claimedAt: new Date() })
          .where(
            and(
              eq(pendingUploads.id, intent.id),
              eq(pendingUploads.status, "scanning"),
              eq(pendingUploads.claimedByRequestId, intent.claimRequestId),
            ),
          );
      });
      if (Result.isError(renewed)) {
        captureError(renewed.error, {
          pendingUploadId: intent.id,
          stage: "buffer-entity-intent-heartbeat",
        });
      }
    } catch (error) {
      captureError(error, {
        pendingUploadId: intent.id,
        stage: "buffer-entity-intent-heartbeat-unhandled",
      });
    } finally {
      heartbeatPromise = null;
    }
  };
  const triggerHeartbeat = (): void => {
    if (heartbeatPromise === null && !stopped) {
      heartbeatPromise = heartbeat();
    }
  };
  const timer = setInterval(triggerHeartbeat, BUFFER_INTENT_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatPromise;
  };
};

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
  afterCreate?:
    | ((tx: Transaction, result: CreateEntityFromBufferValue) => Promise<void>)
    | undefined;
};

class EntityLimitError extends TaggedError("EntityLimitError")<{
  message: string;
}>() {}

class DocumentTooLargeError extends TaggedError("DocumentTooLargeError")<{
  message: string;
}>() {}

class MissingFilePropertyError extends TaggedError("MissingFilePropertyError")<{
  message: string;
}>() {}

class InvalidParentError extends TaggedError("InvalidParentError")<{
  message: string;
}>() {}

type CreateEntityFromBufferValue = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  fileName: string;
};

export type CreateEntityFromBufferResult = Result<
  CreateEntityFromBufferValue,
  | DocumentTooLargeError
  | EntityLimitError
  | InvalidParentError
  | MissingFilePropertyError
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
  afterCreate,
}: CreateEntityFromBufferInput): Promise<CreateEntityFromBufferResult> => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return Result.err(
      new DocumentTooLargeError({
        message: `Document exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte size limit`,
      }),
    );
  }

  const fileName = sanitizeFilenamePreservingExtension(rawFileName);
  const fileId = allocateFileObject();
  const s3Key = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });

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

  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const safeDb = toSafeDb(scopedDb);

  // Durably reserve this exact file id before publishing. A hard death after
  // the S3 write can therefore be distinguished from a committed entity and
  // cleaned by the bounded scheduler without adding a repair query to every
  // request.
  const intent = await reserveEntityCreateIntent({
    safeDb,
    organizationId,
    workspaceId,
    userId,
    propertyId: fileProperty.id,
    fileId,
    fileName,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256Hex,
  });

  const stopIntentHeartbeat = startEntityCreateIntentHeartbeat({
    safeDb,
    intent,
  });

  try {
    const cleanupObject = async (): Promise<boolean> => {
      const cleanup = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (signal) => await deleteS3ObjectWithSignal(s3Key, signal),
            {
              label: "buffer-entity-writer-cleanup.delete",
              timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        captureError(cleanup.error, { entityId, objectKey: s3Key });
        return false;
      }
      return true;
    };

    try {
      await withTimeout(
        async (signal) => await putS3ObjectWithSignal(s3Key, bytes, signal),
        {
          label: "buffer-entity-writer-put",
          timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // A transport failure is ambiguous: S3 may have accepted the object.
      // Keep the intent recoverable unless deletion is confirmed.
      if (await cleanupObject()) {
        await abandonEntityCreateIntent({
          safeDb,
          intent,
          reason: "Server-generated entity object write failed",
        });
      }
      throw error;
    }

    // `scopedDb` cannot distinguish a callback rollback from a lost COMMIT
    // acknowledgement. The intent finalization is atomic with the entity rows;
    // this flag prevents deleting bytes that an ambiguously committed entity
    // may already reference. A real rollback leaves a stale scanning intent for
    // the bounded reconciler.
    const transactionState = { durableReferencePrepared: false };
    try {
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

        await afterCreate?.(tx, { entityId, fieldId, fileName });

        const finalizedResult: Extract<
          PendingUploadFinalizedResult,
          { type: "entity_create" }
        > = {
          type: "entity_create",
          entityId,
          fileId,
          fileName,
          renamed: false,
        };
        // audit: skip — intent bookkeeping is atomic with the audited entity.
        const finalizedRows = await tx
          .update(pendingUploads)
          .set({
            status: "finalized",
            finalizedResult,
            finalizedAt: new Date(),
          })
          .where(
            and(
              eq(pendingUploads.id, intent.id),
              eq(pendingUploads.status, "scanning"),
              eq(pendingUploads.claimedByRequestId, intent.claimRequestId),
            ),
          )
          .returning({ id: pendingUploads.id });
        if (!finalizedRows.at(0)) {
          panic("Entity buffer intent finalize returned no row");
        }
        transactionState.durableReferencePrepared = true;
      });
    } catch (error) {
      if (
        !transactionState.durableReferencePrepared &&
        (await cleanupObject())
      ) {
        await abandonEntityCreateIntent({
          safeDb,
          intent,
          reason: "Server-generated entity transaction failed",
        });
      }

      if (EntityLimitError.is(error) || InvalidParentError.is(error)) {
        return Result.err(error);
      }

      throw error;
    }
  } finally {
    await stopIntentHeartbeat();
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

  broadcast(workspaceId, {
    type: "invalidate-query",
    data: ["entities", workspaceId],
  });

  return Result.ok({ entityId, fieldId, fileName });
};

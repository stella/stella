import { Result, TaggedError, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  pendingUploads,
  workspaces,
} from "@/api/db/schema";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_DELETE_TIMEOUT_MS,
  BUFFER_INTENT_WRITE_TIMEOUT_MS,
  abandonBufferIntent,
  reserveBufferIntent,
  startBufferIntentHeartbeat,
} from "@/api/lib/buffer-intent-reconciliation";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { validateParentIdForInsert } from "@/api/lib/entities/validate-parent-id";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { deleteS3ObjectWithSignal, putS3ObjectWithSignal } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  processExtraction,
  requestNativeExtractionRun,
} from "@/api/lib/search/process-extraction";
import { withTimeout } from "@/api/lib/with-timeout";

const toSafeDb =
  (scopedDb: ScopedDb): SafeDb =>
  async <T>(run: (tx: Transaction) => Promise<T>) =>
    await Result.tryPromise(async () => await scopedDb(run));

const ENTITY_BUFFER_INTENT_TELEMETRY = {
  abandon: "buffer-entity-intent-abandon",
  heartbeat: "buffer-entity-intent-heartbeat",
  heartbeatUnhandled: "buffer-entity-intent-heartbeat-unhandled",
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
  encrypted?: boolean | undefined;
  parentId?: SafeId<"entity"> | null | undefined;
  scanWarnings?: string[] | undefined;
  provenance?:
    | {
        type: "email_attachment";
        attachmentId: string;
        sourceEntityId: SafeId<"entity">;
        sourceFieldId: SafeId<"field">;
        sourceWorkspaceId: SafeId<"workspace">;
      }
    | undefined;
  afterCreate?:
    | ((tx: Transaction, result: CreateEntityFromBufferValue) => Promise<void>)
    | undefined;
  dependencies?: CreateEntityFromBufferDependencies | undefined;
};

export type CreateEntityFromBufferDependencies = {
  broadcastWorkspaceResourceUpdated: typeof broadcastWorkspaceResourceUpdated;
  enqueueImageThumbnailOrMarkFailed: typeof enqueueImageThumbnailOrMarkFailed;
  enqueuePdfDerivativeOrMarkFailed: typeof enqueuePdfDerivativeOrMarkFailed;
  processExtraction: typeof processExtraction;
  requestNativeExtractionRun: typeof requestNativeExtractionRun;
};

const defaultCreateEntityFromBufferDependencies = {
  broadcastWorkspaceResourceUpdated,
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
  processExtraction,
  requestNativeExtractionRun: async (options) =>
    await requestNativeExtractionRun(options),
} satisfies CreateEntityFromBufferDependencies;

class EntityLimitError extends TaggedError("EntityLimitError")<{
  message: string;
}> {}

class DocumentTooLargeError extends TaggedError("DocumentTooLargeError")<{
  message: string;
}> {}

class MissingFilePropertyError extends TaggedError("MissingFilePropertyError")<{
  message: string;
}> {}

class InvalidParentError extends TaggedError("InvalidParentError")<{
  message: string;
}> {}

type CreateEntityFromBufferValue = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
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
  encrypted = false,
  parentId,
  scanWarnings,
  provenance,
  afterCreate,
  dependencies = defaultCreateEntityFromBufferDependencies,
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
  const intent = await reserveBufferIntent({
    safeDb,
    organizationId,
    workspaceId,
    userId,
    purpose: "entity_create",
    purposeData: {
      type: "entity_create",
      propertyId: fileProperty.id,
      reservedFileId: fileId,
    },
    fileName,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256Hex,
  });

  const stopIntentHeartbeat = startBufferIntentHeartbeat({
    safeDb,
    intent,
    telemetry: ENTITY_BUFFER_INTENT_TELEMETRY,
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
        async (signal) =>
          await putS3ObjectWithSignal(s3Key, bytes, mimeType, signal),
        {
          label: "buffer-entity-writer-put",
          timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // A transport failure is ambiguous: S3 may publish after this immediate
      // delete completes. Keep the intent recoverable so later sweeps remove
      // any late publication; the heartbeat stops in finally below.
      await cleanupObject();
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
            encrypted,
            sha256Hex,
            pdfFileId: null,
            pdfDerivative: pdfDerivativeStateForFile({
              encrypted,
              mimeType,
            }),
            thumbnailFileId: null,
            thumbnailDerivative: thumbnailDerivativeStateForFile({
              encrypted,
              mimeType,
            }),
            ...(scanWarnings !== undefined && { scanWarnings }),
          }),
        });

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        // Durable extraction request, committed with the file it reads. The
        // post-commit call below only accelerates the queue handoff.
        await dependencies.requestNativeExtractionRun({ entityId, tx });

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
          ...(provenance && { metadata: { provenance } }),
        });

        await afterCreate?.(tx, {
          entityId,
          entityVersionId,
          fieldId,
          fileName,
        });

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
        await abandonBufferIntent({
          safeDb,
          intent,
          reason: "Server-generated entity transaction failed",
          telemetry: ENTITY_BUFFER_INTENT_TELEMETRY,
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
  dependencies.processExtraction(entityId).catch(captureError);

  dependencies
    .enqueuePdfDerivativeOrMarkFailed({
      encrypted,
      entityId,
      fieldId,
      mimeType,
      organizationId,
      userId,
      workspaceId,
    })
    .catch(captureError);

  dependencies
    .enqueueImageThumbnailOrMarkFailed({
      encrypted,
      entityId,
      fieldId,
      mimeType,
      organizationId,
      userId,
      workspaceId,
    })
    .catch(captureError);

  dependencies.broadcastWorkspaceResourceUpdated(
    workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
  );

  return Result.ok({ entityId, entityVersionId, fieldId, fileName });
};

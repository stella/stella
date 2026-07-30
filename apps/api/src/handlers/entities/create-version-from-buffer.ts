import { Result, TaggedError, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { writeFileVersion } from "@/api/handlers/entities/write-file-version";
import type { WriteFileVersionResult } from "@/api/handlers/entities/write-file-version";
import { allocateFileObject } from "@/api/handlers/files/file-object-ids";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_HEARTBEAT_MS,
  BUFFER_INTENT_TTL_MS,
  reconcileStaleBufferIntents,
} from "@/api/lib/buffer-intent-reconciliation";
import type { DocumentSource } from "@/api/lib/document-source";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";

class EntityVersionTargetError extends TaggedError("EntityVersionTargetError")<{
  code:
    | "current-version-not-found"
    | "document-too-large"
    | "entity-not-found"
    | "entity-read-only"
    | "missing-file-field";
  message: string;
}>() {}

type EntityVersionTargetErrorCode = EntityVersionTargetError["code"];

type CreateEntityVersionFromBufferInput = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  buffer: Uint8Array | ArrayBuffer;
  fileName: string;
  mimeType: string;
  source: DocumentSource | null;
  scanWarnings?: string[] | undefined;
  afterWrite?:
    | ((
        tx: Transaction,
        result: Extract<WriteFileVersionResult, { status: "ok" }>,
      ) => Promise<void>)
    | undefined;
};

export type CreateEntityVersionFromBufferResult = Result<
  {
    entityId: SafeId<"entity">;
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    fileName: string;
    versionNumber: number;
  },
  EntityVersionTargetError
>;

const ENTITY_VERSION_TARGET_MESSAGES = {
  "entity-not-found": "Entity not found",
  "entity-read-only": "Entity is read-only",
  "current-version-not-found": "Current version not found",
  "document-too-large": `Document exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte size limit`,
  "missing-file-field": "Entity has no file field",
} satisfies Record<EntityVersionTargetErrorCode, string>;

const messageForStatus = (status: EntityVersionTargetErrorCode): string =>
  ENTITY_VERSION_TARGET_MESSAGES[status];

type BufferVersionIntent = {
  claimRequestId: string;
  id: SafeId<"pendingUpload">;
};

const reserveBufferVersionIntent = async ({
  safeDb,
  organizationId,
  workspaceId,
  entityId,
  userId,
  fileId,
  fileName,
  mimeType,
  sizeBytes,
  sha256Hex,
}: Pick<
  CreateEntityVersionFromBufferInput,
  "safeDb" | "organizationId" | "workspaceId" | "entityId" | "userId"
> & {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
}): Promise<BufferVersionIntent> => {
  const id = createSafeId<"pendingUpload">();
  const claimRequestId = Bun.randomUUIDv7().slice(0, 64);
  const now = new Date();
  const reserved = await safeDb(async (tx) => {
    // audit: skip — crash-recovery intent; the version transaction records the
    // durable entity and version events.
    const rows = await tx
      .insert(pendingUploads)
      .values({
        id,
        organizationId,
        workspaceId,
        userId,
        purpose: "entity_version",
        purposeData: {
          type: "entity_version",
          entityId,
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
      rows.at(0)?.id ?? panic("Buffer version intent insert returned no row")
    );
  });
  if (Result.isError(reserved)) {
    throw reserved.error;
  }
  return { id: reserved.value, claimRequestId };
};

const abandonBufferVersionIntent = async ({
  safeDb,
  intent,
  reason,
}: {
  safeDb: SafeDb;
  intent: BufferVersionIntent;
  reason: string;
}): Promise<void> => {
  const abandoned = await safeDb(async (tx) => {
    // audit: skip — failed intent bookkeeping; no durable version was created.
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
          eq(pendingUploads.status, "scanning"),
          eq(pendingUploads.claimedByRequestId, intent.claimRequestId),
        ),
      );
  });
  if (Result.isError(abandoned)) {
    captureError(abandoned.error, {
      pendingUploadId: intent.id,
      stage: "buffer-version-intent-abandon",
    });
  }
};

const startBufferVersionIntentHeartbeat = ({
  safeDb,
  intent,
}: {
  safeDb: SafeDb;
  intent: BufferVersionIntent;
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
          stage: "buffer-version-intent-heartbeat",
        });
      }
    } catch (error) {
      captureError(error, {
        pendingUploadId: intent.id,
        stage: "buffer-version-intent-heartbeat-unhandled",
      });
    } finally {
      heartbeatPromise = null;
    }
  };
  const triggerHeartbeat = (): void => {
    if (heartbeatPromise !== null || stopped) {
      return;
    }
    heartbeatPromise = heartbeat();
  };
  const timer = setInterval(triggerHeartbeat, BUFFER_INTENT_HEARTBEAT_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatPromise;
  };
};

/** Persist trusted server-generated bytes as a new version of an entity. */
export const createEntityVersionFromBuffer = async ({
  safeDb,
  organizationId,
  workspaceId,
  entityId,
  userId,
  recordAuditEvent,
  buffer,
  fileName: rawFileName,
  mimeType,
  source,
  scanWarnings,
  afterWrite,
}: CreateEntityVersionFromBufferInput): Promise<CreateEntityVersionFromBufferResult> => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return Result.err(
      new EntityVersionTargetError({
        code: "document-too-large",
        message: messageForStatus("document-too-large"),
      }),
    );
  }

  const fileName = sanitizeFilenamePreservingExtension(rawFileName);
  const fileId = allocateFileObject();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const objectKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });

  // Reconcile older crash leftovers before publishing another final object,
  // then durably reserve this exact file id. A hard death after the S3 write
  // can therefore be distinguished from a committed version and cleaned by a
  // later bounded reconciliation pass.
  await reconcileStaleBufferIntents({
    safeDb,
    organizationId,
    workspaceId,
    purpose: "entity_version",
  });
  const intent = await reserveBufferVersionIntent({
    safeDb,
    organizationId,
    workspaceId,
    entityId,
    userId,
    fileId,
    fileName,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256Hex,
  });

  const stopIntentHeartbeat = startBufferVersionIntentHeartbeat({
    safeDb,
    intent,
  });
  let written: Extract<WriteFileVersionResult, { status: "ok" }>;
  try {
    const cleanupObject = async (): Promise<boolean> => {
      const cleanup = await Result.tryPromise({
        try: async () => await getS3().delete(objectKey),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        captureError(cleanup.error, { entityId, objectKey });
        return false;
      }
      return true;
    };

    try {
      await getS3().write(objectKey, bytes);
    } catch (error) {
      // A timeout or connection failure can be ambiguous: object storage may
      // have accepted the complete object even though the client saw an error.
      // Terminalize the intent only after confirmed deletion; otherwise its
      // live lease remains recoverable by the bounded reconciler.
      if (await cleanupObject()) {
        await abandonBufferVersionIntent({
          safeDb,
          intent,
          reason: "Server-generated version object write failed",
        });
      }
      throw error;
    }

    // `safeDb` cannot distinguish a callback failure (which necessarily rolls
    // back) from a lost COMMIT acknowledgement (which may already be durable).
    // The intent is finalized atomically with the version. Track whether that
    // durable reference was prepared so ambiguous acknowledgements preserve the
    // object; a rolled-back intent remains recoverable by the bounded janitor.
    const transactionState = { durableReferencePrepared: false };
    const writeResult = await safeDb(async (tx) => {
      const versionWriteResult = await writeFileVersion({
        tx,
        workspaceId,
        entityId,
        userId,
        recordAuditEvent,
        entityVersionId,
        fieldId,
        fileId,
        fileName,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256Hex,
        source,
        scanWarnings,
        afterWrite: async (result) => {
          const finalizedResult = {
            type: "entity_version" as const,
            entityId,
            entityVersionId,
            versionNumber: result.versionNumber,
            fileId,
            fileName,
          };
          // audit: skip — intent bookkeeping is atomic with the audited entity
          // and version mutations performed by writeFileVersion.
          const rows = await tx
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
          if (!rows.at(0)) {
            panic("Buffer version intent finalize returned no row");
          }
          if (afterWrite !== undefined) {
            await afterWrite(tx, result);
          }
        },
      });
      transactionState.durableReferencePrepared =
        versionWriteResult.status === "ok";
      return versionWriteResult;
    });
    if (Result.isError(writeResult)) {
      if (
        !transactionState.durableReferencePrepared &&
        (await cleanupObject())
      ) {
        await abandonBufferVersionIntent({
          safeDb,
          intent,
          reason: "Server-generated version transaction failed",
        });
      }
      throw writeResult.error;
    }
    const writeOutcome = writeResult.value;

    if (writeOutcome.status !== "ok") {
      if (await cleanupObject()) {
        await abandonBufferVersionIntent({
          safeDb,
          intent,
          reason: `Server-generated version rejected: ${writeOutcome.status}`,
        });
      }
      return Result.err(
        new EntityVersionTargetError({
          code: writeOutcome.status,
          message: messageForStatus(writeOutcome.status),
        }),
      );
    }
    written = writeOutcome;
  } finally {
    await stopIntentHeartbeat();
  }

  processExtraction(entityId).catch((error: unknown) => {
    captureError(error, { entityId });
  });
  enqueuePdfDerivativeOrMarkFailed({
    encrypted: false,
    entityId,
    fieldId,
    mimeType,
    organizationId,
    userId,
    workspaceId,
  }).catch((error: unknown) => {
    captureError(error, { entityId, fieldId, mimeType });
  });
  enqueueImageThumbnailOrMarkFailed({
    encrypted: false,
    entityId,
    fieldId,
    mimeType,
    organizationId,
    userId,
    workspaceId,
  }).catch((error: unknown) => {
    captureError(error, { entityId, fieldId, mimeType });
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

  return Result.ok({
    entityId,
    entityVersionId,
    fieldId,
    fileName,
    versionNumber: written.versionNumber,
  });
};

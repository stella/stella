import { Result, TaggedError, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
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
import type { DocumentSource } from "@/api/lib/document-source";
import { computeVersionDiffStats } from "@/api/lib/entity-versions/compute-version-diff";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type {
  FileVersionWritePolicy,
  WriteFileVersionResult,
} from "@/api/lib/entity-versions/write-file-version";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { deleteS3ObjectWithSignal, putS3ObjectWithSignal } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  processExtraction,
  requestNativeExtractionRun,
} from "@/api/lib/search/process-extraction";
import { withTimeout } from "@/api/lib/with-timeout";

class EntityVersionTargetError extends TaggedError("EntityVersionTargetError")<{
  code:
    | "current-version-not-found"
    | "current-version-changed"
    | "document-too-large"
    | "edit-session-open"
    | "entity-not-found"
    | "entity-read-only"
    | "missing-file-field"
    | "target-file-not-found"
    | "workspace-not-active";
  message: string;
}> {}

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
  writePolicy: FileVersionWritePolicy;
  scanWarnings?: string[] | undefined;
  afterWrite?:
    | ((
        tx: Transaction,
        result: Extract<WriteFileVersionResult, { status: "ok" }>,
      ) => Promise<void>)
    | undefined;
  dependencies?: CreateEntityVersionFromBufferDependencies | undefined;
};

export type CreateEntityVersionFromBufferDependencies = {
  allocateFileObject: typeof allocateFileObject;
  createFileKey: typeof createFileKey;
  writeFileVersion: typeof writeFileVersion;
  processExtraction: typeof processExtraction;
  requestNativeExtractionRun: typeof requestNativeExtractionRun;
  enqueuePdfDerivativeOrMarkFailed: typeof enqueuePdfDerivativeOrMarkFailed;
  enqueueImageThumbnailOrMarkFailed: typeof enqueueImageThumbnailOrMarkFailed;
  computeVersionDiffStats: typeof computeVersionDiffStats;
  createRootScopedDb: typeof createRootScopedDb;
  broadcast: Parameters<typeof broadcastWorkspaceResourceUpdated>[2];
};

const CREATE_ENTITY_VERSION_FROM_BUFFER_DEPENDENCIES: CreateEntityVersionFromBufferDependencies =
  {
    allocateFileObject,
    createFileKey,
    writeFileVersion,
    processExtraction,
    requestNativeExtractionRun: async (options) =>
      await requestNativeExtractionRun(options),
    enqueuePdfDerivativeOrMarkFailed,
    enqueueImageThumbnailOrMarkFailed,
    computeVersionDiffStats,
    createRootScopedDb,
    broadcast: undefined,
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
  "current-version-changed":
    "The document changed while edits were being applied; retry against the current version",
  "document-too-large": `Document exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte size limit`,
  "edit-session-open":
    "The document has an active edit session; close it before automatic edits",
  "missing-file-field": "Entity has no file field",
  "target-file-not-found": "The document file changed while edits were applied",
  "workspace-not-active": "The document's matter is archived or unavailable",
} satisfies Record<EntityVersionTargetErrorCode, string>;

const messageForStatus = (status: EntityVersionTargetErrorCode): string =>
  ENTITY_VERSION_TARGET_MESSAGES[status];

const VERSION_BUFFER_INTENT_TELEMETRY = {
  abandon: "buffer-version-intent-abandon",
  heartbeat: "buffer-version-intent-heartbeat",
  heartbeatUnhandled: "buffer-version-intent-heartbeat-unhandled",
};

/** Persist trusted server-generated bytes through the durable version boundary. */
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
  writePolicy,
  scanWarnings,
  afterWrite,
  dependencies = CREATE_ENTITY_VERSION_FROM_BUFFER_DEPENDENCIES,
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
  const fileId = dependencies.allocateFileObject();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const objectKey = dependencies.createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });

  // Durably reserve this exact file id before publishing. A hard death after
  // the S3 write can therefore be distinguished from a committed version and
  // cleaned by the bounded scheduler without adding a repair query to every
  // request.
  const intent = await reserveBufferIntent({
    safeDb,
    organizationId,
    workspaceId,
    userId,
    purpose: "entity_version",
    purposeData: {
      type: "entity_version",
      entityId,
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
    telemetry: VERSION_BUFFER_INTENT_TELEMETRY,
  });
  let written: Extract<WriteFileVersionResult, { status: "ok" }>;
  try {
    const cleanupObject = async (): Promise<boolean> => {
      const cleanup = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (signal) => await deleteS3ObjectWithSignal(objectKey, signal),
            {
              label: "buffer-version-writer-cleanup.delete",
              timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        captureError(cleanup.error, { entityId, objectKey });
        return false;
      }
      return true;
    };

    try {
      await withTimeout(
        async (signal) =>
          await putS3ObjectWithSignal(objectKey, bytes, mimeType, signal),
        {
          label: "buffer-version-writer-put",
          timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // A timeout or connection failure can be ambiguous: object storage may
      // publish after the immediate delete completes. Keep the intent
      // recoverable so later sweeps remove any late publication; the
      // heartbeat stops in finally below.
      await cleanupObject();
      throw error;
    }

    // `safeDb` cannot distinguish a callback failure (which necessarily rolls
    // back) from a lost COMMIT acknowledgement (which may already be durable).
    // The intent is finalized atomically with the version. Track whether that
    // durable reference was prepared so ambiguous acknowledgements preserve the
    // object; a rolled-back intent remains recoverable by the bounded janitor.
    const transactionState = { durableReferencePrepared: false };
    const writeResult = await safeDb(async (tx) => {
      const versionWriteResult = await dependencies.writeFileVersion({
        tx,
        organizationId,
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
        writePolicy,
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
      if (versionWriteResult.status === "ok") {
        // Durable extraction request, committed with the version that owns the
        // file. The post-commit call below only accelerates the queue handoff,
        // so it pins the same file property and resolves the same source.
        await dependencies.requestNativeExtractionRun({
          entityId,
          filePropertyId: versionWriteResult.filePropertyId,
          tx,
        });
      }
      // Set last, after every fallible write in this transaction: the flag
      // means a committed row may reference the object, so cleanup must be
      // skipped. A throw before this point rolls the transaction back, leaving
      // nothing to reference the object, and the caller's cleanup should run.
      transactionState.durableReferencePrepared =
        versionWriteResult.status === "ok";
      return versionWriteResult;
    });
    if (Result.isError(writeResult)) {
      if (
        !transactionState.durableReferencePrepared &&
        (await cleanupObject())
      ) {
        await abandonBufferIntent({
          safeDb,
          intent,
          reason: "Server-generated version transaction failed",
          telemetry: VERSION_BUFFER_INTENT_TELEMETRY,
        });
      }
      throw writeResult.error;
    }
    const writeOutcome = writeResult.value;

    if (writeOutcome.status !== "ok") {
      if (await cleanupObject()) {
        await abandonBufferIntent({
          safeDb,
          intent,
          reason: `Server-generated version rejected: ${writeOutcome.status}`,
          telemetry: VERSION_BUFFER_INTENT_TELEMETRY,
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

  dependencies
    .processExtraction(entityId, {
      filePropertyId: written.filePropertyId,
    })
    .catch((error: unknown) => {
      captureError(error, { entityId });
    });
  dependencies
    .enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId,
      mimeType,
      organizationId,
      userId,
      workspaceId,
    })
    .catch((error: unknown) => {
      captureError(error, { entityId, fieldId, mimeType });
    });
  dependencies
    .enqueueImageThumbnailOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId,
      mimeType,
      organizationId,
      userId,
      workspaceId,
    })
    .catch((error: unknown) => {
      captureError(error, { entityId, fieldId, mimeType });
    });
  dependencies
    .computeVersionDiffStats({
      versionId: entityVersionId,
      entityId,
      scopedDb: dependencies.createRootScopedDb({
        organizationId,
        userId,
        workspaceIds: [workspaceId],
      }),
      workspaceId,
      organizationId,
    })
    .catch((error: unknown) => {
      captureError(error, { versionId: entityVersionId });
    });
  broadcastWorkspaceResourceUpdated(
    workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
    dependencies.broadcast,
  );

  return Result.ok({
    entityId,
    entityVersionId,
    fieldId,
    fileName,
    versionNumber: written.versionNumber,
  });
};

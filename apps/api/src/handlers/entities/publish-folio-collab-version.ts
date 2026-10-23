import { panic, Result } from "better-result";
import { t } from "elysia";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { captureError } from "@/api/lib/analytics/capture";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isBufferIntentWorkspaceUnavailableError,
  objectWriterSettlementAfterCleanup,
  reserveObjectCleanupIntent,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { computeVersionDiffStats } from "@/api/lib/entity-versions/compute-version-diff";
import {
  loadPublicationPreliminary,
  matchesFolioCollabCheckpointCut,
  preparePublicationBytes,
  publishCheckpointInTransaction,
  PUBLISHED_FILE_ENCRYPTION,
} from "@/api/lib/entity-versions/publish-folio-collab-checkpoint";
import type {
  PublicationPreliminary,
  PublicationSource,
} from "@/api/lib/entity-versions/publish-folio-collab-checkpoint";
import { validateDesktopEditFileBuffer } from "@/api/lib/entity-versions/validate-desktop-edit-file-buffer";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { scanFile } from "@/api/lib/file-scan/scan";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import { createFileKey } from "@/api/lib/files/utils";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  readS3ArrayBuffer,
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export {
  hashPublishedFolioCollabBytes,
  matchesFolioCollabCheckpointCut,
  matchesFolioCollabPublishedCut,
} from "@/api/lib/entity-versions/publish-folio-collab-checkpoint";

const FOLIO_COLLAB_PUBLICATION_IDEMPOTENCY_CONSTRAINT =
  "folio_collab_publications_idempotency_uidx";

export const isFolioCollabIdempotencyConstraintError = (error: unknown) =>
  DatabaseError.is(error) &&
  isPgConstraintError(
    error.cause,
    PG_ERROR.UNIQUE_VIOLATION,
    FOLIO_COLLAB_PUBLICATION_IDEMPOTENCY_CONSTRAINT,
  );

const publishFolioCollabVersionBodySchema = t.Object({
  description: t.Optional(t.String({ maxLength: 1024 })),
  expectedGeneration: t.Integer({ minimum: 0 }),
  expectedSha256Hex: t.String({ minLength: 64, maxLength: 64 }),
  idempotencyKey: t.String({ format: "uuid" }),
  label: t.Optional(t.String({ maxLength: 128 })),
  roomId: tSafeId("folioCollabRoom"),
});

type CheckpointRoom = Extract<
  PublicationPreliminary,
  { status: "checkpoint" }
>["room"];

type CheckpointRoomToPublishOptions = {
  cut: { expectedGeneration: number; expectedSha256Hex: string };
  preliminary: Exclude<PublicationPreliminary, { status: "published" }>;
};

const checkpointRoomToPublish = ({
  cut: { expectedGeneration, expectedSha256Hex },
  preliminary,
}: CheckpointRoomToPublishOptions): Result<CheckpointRoom, HandlerError> => {
  switch (preliminary.status) {
    case "idempotency-conflict":
      return Result.err(
        new HandlerError({
          code: "folio_collab_idempotency_key_reused",
          status: 409,
          message: "This publication key was already used for another room.",
        }),
      );
    case "missing":
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    case "checkpoint": {
      const { room } = preliminary;
      if (
        !matchesFolioCollabCheckpointCut({
          checkpoint: room,
          expectedFileId: room.checkpointFileId,
          expectedGeneration,
          expectedSha256Hex,
        }) ||
        room.checkpointSizeBytes === null
      ) {
        return Result.err(
          new HandlerError({
            code: "folio_collab_checkpoint_changed",
            status: 409,
            message:
              "Collaborative checkpoint changed. Create a new checkpoint.",
          }),
        );
      }
      return Result.ok(room);
    }
    default: {
      preliminary satisfies never;
      return panic(`Unhandled publication preliminary: ${String(preliminary)}`);
    }
  }
};

type ReadPublishableCheckpointOptions = {
  checkpointKey: string;
  expectedSha256Hex: string;
  fileName: string;
  signal: AbortSignal;
};

/** Reads the checkpoint and refuses bytes that fail the hash, format or scan. */
export const readPublishableCheckpoint = async ({
  checkpointKey,
  expectedSha256Hex,
  fileName,
  signal,
}: ReadPublishableCheckpointOptions): Promise<
  Result<Uint8Array<ArrayBuffer>, HandlerError>
> => {
  const checkpoint = await readS3ArrayBuffer(checkpointKey, signal);
  const checkpointBytes = new Uint8Array(checkpoint);
  const actualSha256Hex = hashSha256Hex(checkpointBytes);
  if (actualSha256Hex !== expectedSha256Hex) {
    return Result.err(
      new HandlerError({
        code: "folio_collab_checkpoint_changed",
        status: 409,
        message: "Collaborative checkpoint bytes do not match its stored hash.",
      }),
    );
  }
  const validation = await validateDesktopEditFileBuffer({
    buffer: checkpoint,
    fileType: "docx",
  });
  if (!validation.valid) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: `File validation failed: ${validation.error}`,
      }),
    );
  }
  const scanResult = await scanFile({
    buffer: checkpointBytes,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanResult) || scanResult.value.verdict === "reject") {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Collaborative checkpoint failed its publication scan.",
      }),
    );
  }
  return Result.ok(checkpointBytes);
};

type CleanupPublicationSourceOptions = {
  roomId: SafeId<"folioCollabRoom">;
  safeDb: SafeDb;
  source: PublicationSource;
  writeCertainty: S3ObjectWriteCertainty;
};

const cleanupPublicationSource = async ({
  roomId,
  safeDb,
  source,
  writeCertainty,
}: CleanupPublicationSourceOptions): Promise<void> => {
  const cleanup = Result.flatten(
    await Result.tryPromise({
      try: async () =>
        await deleteOrganizationFileWithSignal(
          source.key,
          AbortSignal.timeout(10_000),
        ),
      catch: (cause) => cause,
    }),
  );
  if (Result.isError(cleanup)) {
    captureError(
      cleanup.error,
      handlerErrorContext("entities.cleanupPublicationSource.cleanup_error", {
        roomId,
        storageKey: source.key,
      }),
    );
  }
  const settlement = await settleObjectCleanupIntentsAfterWriter({
    intentIds: [source.cleanupIntentId],
    objectState: objectWriterSettlementAfterCleanup({
      cleanupSucceeded: Result.isOk(cleanup),
      writeState: writeCertainty,
    }),
    safeDb,
  });
  if (Result.isError(settlement)) {
    captureError(
      settlement.error,
      handlerErrorContext(
        "entities.cleanupPublicationSource.settlement_error",
        { roomId, storageKey: source.key },
      ),
    );
  }
};

type StorePublicationSourceOptions = {
  bytes: Uint8Array;
  roomId: SafeId<"folioCollabRoom">;
  safeDb: SafeDb;
  source: PublicationSource;
};

const storePublicationSource = async ({
  bytes,
  roomId,
  safeDb,
  source,
}: StorePublicationSourceOptions) => {
  const written = !isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")
    ? await Result.tryPromise({
        try: async () =>
          await writeS3ObjectWithRetry(
            {
              contentType: DOCX_MIME_TYPE,
              data: bytes,
              key: source.key,
            },
            { type: "cleanup-intent", intent: source.cleanupIntentId },
          ),
        catch: (cause) => cause,
      })
    : Result.mapError(
        await writeOrganizationFile({
          organizationId: source.organizationId,
          objectKey: source.key,
          sizeBytes: bytes.byteLength,
          content: bytes,
          write: async ({ content, objectKey }) =>
            await writeS3ObjectWithRetry(
              {
                contentType: DOCX_MIME_TYPE,
                data: content,
                key: objectKey,
              },
              { type: "cleanup-intent", intent: source.cleanupIntentId },
            ),
        }),
        (cause): unknown => cause,
      );
  if (Result.isError(written)) {
    await cleanupPublicationSource({
      roomId,
      safeDb,
      source,
      writeCertainty: S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN,
    });
    return Result.err(
      new HandlerError({
        cause: written.error,
        status: 500,
        message: "Failed to store the collaborative publication.",
      }),
    );
  }
  return Result.ok(written.value);
};

type Publication = Awaited<ReturnType<typeof publishCheckpointInTransaction>>;

const publicationFailure = (error: SafeDbError) => {
  if (isBufferIntentWorkspaceUnavailableError(error)) {
    return new HandlerError({
      status: 409,
      message: "This document cannot be published right now.",
    });
  }
  if (isFolioCollabIdempotencyConstraintError(error)) {
    return new HandlerError({
      code: "folio_collab_idempotency_key_reused",
      status: 409,
      message: "This publication key was already used.",
    });
  }
  return error;
};

type StartPublicationFollowUpsOptions = {
  organizationId: SafeId<"organization">;
  publication: Extract<Publication, { status: "created" }>;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/** Broadcasts the new version and starts its extraction, PDF and diff work. */
const startPublicationFollowUps = async ({
  organizationId,
  publication,
  safeDb,
  userId,
  workspaceId,
}: StartPublicationFollowUpsOptions) => {
  broadcastWorkspaceResourceUpdated(
    workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: publication.entityId }),
  );
  await processExtraction(publication.entityId).catch((error: unknown) => {
    captureError(
      error,
      handlerErrorContext("publication.processExtraction", {
        entityId: publication.entityId,
      }),
    );
  });
  enqueuePdfDerivativeOrMarkFailed({
    encrypted: PUBLISHED_FILE_ENCRYPTION.encrypted,
    entityId: publication.entityId,
    fieldId: publication.fieldId,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    userId: brandPersistedUserId(userId),
    workspaceId,
  }).catch((error: unknown) => {
    captureError(
      error,
      handlerErrorContext("publication.enqueuePdfDerivative", {
        entityId: publication.entityId,
        fieldId: publication.fieldId,
      }),
    );
  });
  computeVersionDiffStats({
    entityId: publication.entityId,
    organizationId,
    scopedDb: async (callback) => {
      const result = await safeDb(callback);
      return result.unwrap(
        "Collaboration version diff reads stay inside the authorized workspace scope.",
      );
    },
    versionId: publication.versionId,
    workspaceId,
  }).catch((error: unknown) => {
    captureError(
      error,
      handlerErrorContext("publication.computeVersionDiff", {
        versionId: publication.versionId,
      }),
    );
  });
};

const publicationRejection = (
  publication: Exclude<Publication, { status: "created" | "idempotent" }>,
) => {
  switch (publication.status) {
    case "base-drift":
      return new HandlerError({
        code: "folio_collab_base_version_changed",
        status: 409,
        message:
          "A newer document version exists. The collaboration checkpoint was retained.",
      });
    case "checkpoint-changed":
      return new HandlerError({
        code: "folio_collab_checkpoint_changed",
        status: 409,
        message: "Collaborative checkpoint changed. Create a new checkpoint.",
      });
    case "idempotency-conflict":
      return new HandlerError({
        code: "folio_collab_idempotency_key_reused",
        status: 409,
        message: "This publication key was already used for another room.",
      });
    case "read-only":
      return new HandlerError({
        status: 409,
        message: "This document is read-only and cannot be published.",
      });
    case "unavailable":
      return new HandlerError({
        status: 409,
        message: "This document cannot be published right now.",
      });
    case "missing":
      return new HandlerError({
        status: 404,
        message: "Collaborative editing room not found.",
      });
    default: {
      publication satisfies never;
      return panic(`Unhandled publication: ${String(publication)}`);
    }
  }
};

const publishFolioCollabVersion = createSafeHandler(
  {
    contract: "patch",
    contentDelivery: {
      type: "none",
      reason: "Processes collaboration content without returning stored files.",
    },
    body: publishFolioCollabVersionBodySchema,
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "session_token_exchange" },
  } satisfies WorkspaceHandlerConfig,
  async function* ({
    body,
    recordAuditEvent,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;
    const preliminary = yield* Result.await(
      safeDb(
        async (tx) =>
          await loadPublicationPreliminary({ cut: body, tx, workspaceId }),
      ),
    );
    if (preliminary.status === "published") {
      return Result.ok({ ...preliminary, idempotent: true });
    }
    const checkpointRoom = yield* checkpointRoomToPublish({
      cut: body,
      preliminary,
    });

    const checkpointKey = createFileKey({
      fileId: checkpointRoom.checkpointFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      workspaceId,
    });
    const checkpointBytes = yield* Result.await(
      readPublishableCheckpoint({
        checkpointKey,
        expectedSha256Hex: body.expectedSha256Hex,
        fileName: checkpointRoom.fileName,
        signal: request.signal,
      }),
    );

    const { storedBytes, storedSha256Hex } = await preparePublicationBytes(
      checkpointBytes,
      body.expectedSha256Hex,
    );

    const sourceFileId = allocateFileObject();
    const sourceKey = createFileKey({
      fileId: sourceFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      workspaceId,
    });
    const sourceCleanupIntentId = yield* Result.await(
      reserveObjectCleanupIntent({
        objectKey: sourceKey,
        organizationId,
        safeDb,
        workspaceId,
      }),
    );
    const source = {
      cleanupIntentId: sourceCleanupIntentId,
      fileId: sourceFileId,
      key: sourceKey,
      organizationId,
    } satisfies PublicationSource;
    const writeCertainty = yield* Result.await(
      storePublicationSource({
        bytes: storedBytes,
        roomId: body.roomId,
        safeDb,
        source,
      }),
    );

    const publicationResult = await safeDb(
      async (tx) =>
        await publishCheckpointInTransaction({
          body,
          checkpointKey,
          checkpointRoom,
          organizationId,
          recordAuditEvent,
          source,
          storedSha256Hex,
          storedSizeBytes: storedBytes.byteLength,
          tx,
          userId: user.id,
          workspaceId,
        }),
    );
    if (Result.isError(publicationResult)) {
      await cleanupPublicationSource({
        roomId: body.roomId,
        safeDb,
        source,
        writeCertainty,
      });
      return Result.err(publicationFailure(publicationResult.error));
    }
    const publication = publicationResult.value;

    if (publication.status === "created") {
      await startPublicationFollowUps({
        organizationId,
        publication,
        safeDb,
        userId: user.id,
        workspaceId,
      });
      return Result.ok({
        idempotent: false,
        status: "published",
        versionId: publication.versionId,
        versionNumber: publication.versionNumber,
      });
    }

    await cleanupPublicationSource({
      roomId: body.roomId,
      safeDb,
      source,
      writeCertainty,
    });
    if (publication.status === "idempotent") {
      return Result.ok({
        idempotent: true,
        status: "published",
        versionId: publication.versionId,
        versionNumber: publication.versionNumber,
      });
    }
    return Result.err(publicationRejection(publication));
  },
);

export default publishFolioCollabVersion;

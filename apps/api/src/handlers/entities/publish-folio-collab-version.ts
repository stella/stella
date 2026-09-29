import { panic, Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  entityVersions,
  folioCollabContributions,
  folioCollabPublications,
  folioCollabRooms,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isBufferIntentWorkspaceUnavailableError,
  lockActiveWorkspaceForBufferIntent,
  lockObjectCleanupIntentsForWriter,
  objectWriterSettlementAfterCleanup,
  reserveObjectCleanupIntent,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { tSafeId } from "@/api/lib/custom-schema";
import { COLLABORATION_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import { computeVersionDiffStats } from "@/api/lib/entity-versions/compute-version-diff";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { validateDesktopEditFileBuffer } from "@/api/lib/entity-versions/validate-desktop-edit-file-buffer";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type { WriteFileVersionResult } from "@/api/lib/entity-versions/write-file-version";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { scanFile } from "@/api/lib/file-scan/scan";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import type { MintedFileId } from "@/api/lib/files/file-object-ids";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";
import { createFileKey } from "@/api/lib/files/utils";
import {
  FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT,
  FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS,
} from "@/api/lib/folio-collab-room-contract";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  deleteS3ObjectWithSignal,
  readS3ArrayBuffer,
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  processExtraction,
  requestNativeExtractionRun,
} from "@/api/lib/search/process-extraction";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CHECKPOINT_CLEANUP_GRACE_MS = 60_000;
const FOLIO_COLLAB_PUBLICATION_IDEMPOTENCY_CONSTRAINT =
  "folio_collab_publications_idempotency_uidx";

type FolioCollabCheckpointCut = {
  checkpointFileId: SafeId<"userFile">;
  checkpointSha256Hex: string | null;
  checkpointUpdatedAt: Date | null;
  generation: number;
};

export const matchesFolioCollabCheckpointCut = ({
  checkpoint,
  expectedFileId,
  expectedGeneration,
  expectedSha256Hex,
}: {
  checkpoint: FolioCollabCheckpointCut;
  expectedFileId: SafeId<"userFile">;
  expectedGeneration: number;
  expectedSha256Hex: string;
}) =>
  checkpoint.generation === expectedGeneration &&
  checkpoint.checkpointSha256Hex === expectedSha256Hex &&
  checkpoint.checkpointFileId === expectedFileId &&
  checkpoint.checkpointUpdatedAt !== null;

type FolioCollabPublishedCut = {
  checkpointSha256Hex: string;
  generation: number;
  roomId: SafeId<"folioCollabRoom">;
};

export const matchesFolioCollabPublishedCut = ({
  expectedGeneration,
  expectedSha256Hex,
  published,
  roomId,
}: {
  expectedGeneration: number;
  expectedSha256Hex: string;
  published: FolioCollabPublishedCut;
  roomId: SafeId<"folioCollabRoom">;
}) =>
  published.roomId === roomId &&
  published.generation === expectedGeneration &&
  published.checkpointSha256Hex === expectedSha256Hex;

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

type PublishFolioCollabVersionBody = Static<
  typeof publishFolioCollabVersionBodySchema
>;

type PublicationCut = Pick<
  PublishFolioCollabVersionBody,
  "expectedGeneration" | "expectedSha256Hex" | "idempotencyKey" | "roomId"
>;

const findPublicationByIdempotencyKey = async (
  tx: Transaction,
  idempotencyKey: string,
) => {
  const prior = await tx
    .select({
      checkpointSha256Hex: folioCollabPublications.checkpointSha256Hex,
      generation: folioCollabPublications.generation,
      roomId: folioCollabPublications.roomId,
      versionId: folioCollabPublications.entityVersionId,
      versionNumber: entityVersions.versionNumber,
    })
    .from(folioCollabPublications)
    .innerJoin(
      entityVersions,
      eq(entityVersions.id, folioCollabPublications.entityVersionId),
    )
    .where(eq(folioCollabPublications.idempotencyKey, idempotencyKey))
    .limit(1);
  return prior.at(0);
};

type LoadPublicationPreliminaryOptions = {
  cut: PublicationCut;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

const loadPublicationPreliminary = async ({
  cut: { expectedGeneration, expectedSha256Hex, idempotencyKey, roomId },
  tx,
  workspaceId,
}: LoadPublicationPreliminaryOptions) => {
  const published = await findPublicationByIdempotencyKey(tx, idempotencyKey);
  if (published) {
    if (
      !matchesFolioCollabPublishedCut({
        expectedGeneration,
        expectedSha256Hex,
        published,
        roomId,
      })
    ) {
      return { status: "idempotency-conflict" } as const;
    }
    return {
      status: "published",
      versionId: published.versionId,
      versionNumber: published.versionNumber,
    } as const;
  }

  const rooms = await tx
    .select({
      checkpointFileId: folioCollabRooms.docxCheckpointFileId,
      checkpointScanWarnings: folioCollabRooms.docxCheckpointScanWarnings,
      checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
      checkpointSizeBytes: folioCollabRooms.docxCheckpointSizeBytes,
      checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
      entityId: folioCollabRooms.entityId,
      fileName: folioCollabRooms.fileName,
      generation: folioCollabRooms.generation,
      propertyId: folioCollabRooms.propertyId,
    })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const room = rooms.at(0);
  return room
    ? ({ status: "checkpoint", room } as const)
    : ({ status: "missing" } as const);
};

type PublicationPreliminary = Awaited<
  ReturnType<typeof loadPublicationPreliminary>
>;

type CheckpointRoom = Extract<
  PublicationPreliminary,
  { status: "checkpoint" }
>["room"];

type CheckpointRoomToPublishOptions = {
  cut: PublicationCut;
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
const readPublishableCheckpoint = async ({
  checkpointKey,
  expectedSha256Hex,
  fileName,
  signal,
}: ReadPublishableCheckpointOptions): Promise<
  Result<Uint8Array<ArrayBuffer>, HandlerError>
> => {
  const checkpoint = await readS3ArrayBuffer(checkpointKey, signal);
  const checkpointBytes = new Uint8Array(checkpoint);
  const actualSha256Hex = new Bun.CryptoHasher("sha256")
    .update(checkpointBytes)
    .digest("hex");
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

type PublicationSource = {
  cleanupIntentId: SafeId<"pendingUpload">;
  fileId: MintedFileId;
  key: string;
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
  const cleanup = await Result.tryPromise({
    try: async () =>
      await deleteS3ObjectWithSignal(source.key, AbortSignal.timeout(10_000)),
    catch: (cause) => cause,
  });
  if (Result.isError(cleanup)) {
    captureError(cleanup.error, { roomId, storageKey: source.key });
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
    captureError(settlement.error, { roomId, storageKey: source.key });
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
  const written = await Result.tryPromise({
    try: async () =>
      await writeS3ObjectWithRetry({
        contentType: DOCX_MIME_TYPE,
        data: bytes,
        key: source.key,
      }),
    catch: (cause) => cause,
  });
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

type RoomScopeOptions = {
  roomId: SafeId<"folioCollabRoom">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

const lockPublicationRoom = async ({
  roomId,
  tx,
  workspaceId,
}: RoomScopeOptions) => {
  const rooms = await tx
    .select({
      baseVersionId: folioCollabRooms.baseVersionId,
      checkpointFileId: folioCollabRooms.docxCheckpointFileId,
      checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
      checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
      entityId: folioCollabRooms.entityId,
      generation: folioCollabRooms.generation,
      propertyId: folioCollabRooms.propertyId,
    })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("update");
  return rooms.at(0);
};

type LockedPublicationRoom = NonNullable<
  Awaited<ReturnType<typeof lockPublicationRoom>>
>;

const loadRoomContributors = async ({
  roomId,
  tx,
  workspaceId,
}: RoomScopeOptions) =>
  await tx
    .select({
      id: folioCollabContributions.id,
      updatedAt: folioCollabContributions.updatedAt,
      userId: folioCollabContributions.userId,
    })
    .from(folioCollabContributions)
    .where(
      and(
        eq(folioCollabContributions.roomId, roomId),
        eq(folioCollabContributions.workspaceId, workspaceId),
      ),
    )
    .orderBy(
      asc(folioCollabContributions.createdAt),
      asc(folioCollabContributions.id),
    )
    .limit(FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT);

type RoomContributor = Awaited<ReturnType<typeof loadRoomContributors>>[number];

type RecordRoomPublicationOptions = {
  checkpointKey: string;
  contributors: RoomContributor[];
  cut: PublicationCut;
  nextCheckpointFileId: SafeId<"userFile">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  room: LockedPublicationRoom;
  sourceCleanupIntentId: SafeId<"pendingUpload">;
  tx: Transaction;
  versionId: SafeId<"entityVersion">;
  versionNumber: number;
  workspaceId: SafeId<"workspace">;
};

/**
 * Moves the room onto the published version inside the version write: clears
 * the checkpoint, records the publication, carries connected contributors
 * over, and queues the old checkpoint object for cleanup.
 */
const recordRoomPublication = async ({
  checkpointKey,
  contributors,
  cut: { expectedGeneration, expectedSha256Hex, idempotencyKey, roomId },
  nextCheckpointFileId,
  organizationId,
  recordAuditEvent,
  room,
  sourceCleanupIntentId,
  tx,
  versionId,
  versionNumber,
  workspaceId,
}: RecordRoomPublicationOptions) => {
  await tx
    .update(folioCollabRooms)
    .set({
      baseVersionId: versionId,
      docxCheckpointFileId: nextCheckpointFileId,
      docxCheckpointScanWarnings: null,
      docxCheckpointSha256Hex: null,
      docxCheckpointSizeBytes: null,
      docxCheckpointUpdatedAt: null,
    })
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
        eq(folioCollabRooms.generation, expectedGeneration),
        eq(folioCollabRooms.docxCheckpointSha256Hex, expectedSha256Hex),
      ),
    );
  await tx.insert(folioCollabPublications).values({
    checkpointSha256Hex: expectedSha256Hex,
    entityId: room.entityId,
    entityVersionId: versionId,
    generation: expectedGeneration,
    id: createSafeId<"folioCollabPublication">(),
    idempotencyKey,
    roomId,
    workspaceId,
  });
  await tx
    .delete(folioCollabContributions)
    .where(
      and(
        eq(folioCollabContributions.roomId, roomId),
        eq(folioCollabContributions.workspaceId, workspaceId),
      ),
    );
  const activeContributorCutoff =
    Temporal.Now.instant().epochMilliseconds -
    FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS;
  const connectedContributorRows = contributors.filter(
    (contributor) => contributor.updatedAt.getTime() > activeContributorCutoff,
  );
  if (connectedContributorRows.length > 0) {
    await tx.insert(folioCollabContributions).values(
      connectedContributorRows.map((contributor) => ({
        entityId: room.entityId,
        id: createSafeId<"folioCollabContribution">(),
        roomId,
        sinceVersionId: versionId,
        updatedAt: contributor.updatedAt,
        userId: contributor.userId,
        workspaceId,
      })),
    );
  }
  // audit: skip — durable storage recovery bookkeeping; the room
  // publication and canonical entity/version mutations are audited.
  await tx.insert(bufferObjectCleanupIntents).values({
    id: createSafeId<"pendingUpload">(),
    nextAttemptAt: new Date(
      Temporal.Now.instant().epochMilliseconds + CHECKPOINT_CLEANUP_GRACE_MS,
    ),
    objectKey: checkpointKey,
    organizationId,
    status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
    workspaceId,
  });
  await retirePublishedObjectCleanupIntentsInTransaction({
    intentIds: [sourceCleanupIntentId],
    tx,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
    resourceId: roomId,
    changes: {
      baseVersionId: { old: room.baseVersionId, new: versionId },
      checkpointSha256Hex: {
        old: expectedSha256Hex,
        new: null,
      },
    },
    metadata: { versionNumber },
  });
};

const publicationOutcome = (
  versionWrite: WriteFileVersionResult,
  entityId: SafeId<"entity">,
) => {
  switch (versionWrite.status) {
    case "ok":
      return {
        entityId,
        fieldId: versionWrite.fieldId,
        status: "created",
        versionId: versionWrite.entityVersionId,
        versionNumber: versionWrite.versionNumber,
      } as const;
    case "current-version-changed":
    case "current-version-not-found":
    case "source-version-not-found":
    case "missing-file-field":
    case "target-file-not-found":
      return { status: "base-drift" } as const;
    case "entity-not-found":
      return { status: "missing" } as const;
    case "entity-read-only":
      return { status: "read-only" } as const;
    case "edit-session-open":
    case "workspace-not-active":
      return { status: "unavailable" } as const;
    case "replayed":
      return panic(
        "Collaboration publication cannot replay a derived comparison",
      );
    default: {
      versionWrite satisfies never;
      return panic(`Unhandled version write: ${String(versionWrite)}`);
    }
  }
};

type PublishCheckpointOptions = {
  body: PublishFolioCollabVersionBody;
  checkpointKey: string;
  checkpointRoom: CheckpointRoom;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  source: PublicationSource;
  storedSha256Hex: string;
  storedSizeBytes: number;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const publishCheckpointInTransaction = async ({
  body,
  checkpointKey,
  checkpointRoom,
  organizationId,
  recordAuditEvent,
  source,
  storedSha256Hex,
  storedSizeBytes,
  tx,
  userId,
  workspaceId,
}: PublishCheckpointOptions) => {
  const { description, label, roomId } = body;
  await lockActiveWorkspaceForBufferIntent(tx, workspaceId);
  await lockDocxEditTarget({
    entityId: checkpointRoom.entityId,
    propertyId: checkpointRoom.propertyId,
    tx,
    workspaceId,
  });
  const room = await lockPublicationRoom({ roomId, tx, workspaceId });
  if (!room) {
    return { status: "missing" } as const;
  }

  const alreadyPublished = await findPublicationByIdempotencyKey(
    tx,
    body.idempotencyKey,
  );
  if (alreadyPublished) {
    if (
      !matchesFolioCollabPublishedCut({
        expectedGeneration: body.expectedGeneration,
        expectedSha256Hex: body.expectedSha256Hex,
        published: alreadyPublished,
        roomId,
      })
    ) {
      return { status: "idempotency-conflict" } as const;
    }
    return {
      status: "idempotent",
      versionId: alreadyPublished.versionId,
      versionNumber: alreadyPublished.versionNumber,
    } as const;
  }
  if (
    !matchesFolioCollabCheckpointCut({
      checkpoint: room,
      expectedFileId: checkpointRoom.checkpointFileId,
      expectedGeneration: body.expectedGeneration,
      expectedSha256Hex: body.expectedSha256Hex,
    })
  ) {
    return { status: "checkpoint-changed" } as const;
  }
  await lockObjectCleanupIntentsForWriter(tx, [source.cleanupIntentId]);

  const contributors = await loadRoomContributors({ roomId, tx, workspaceId });
  const contributorUserIds = contributors.map(
    (contributor) => contributor.userId,
  );
  const versionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const nextCheckpointFileId = createSafeId<"userFile">();
  const versionWrite = await writeFileVersion({
    afterWrite: async ({ versionNumber }) => {
      await recordRoomPublication({
        checkpointKey,
        contributors,
        cut: body,
        nextCheckpointFileId,
        organizationId,
        recordAuditEvent,
        room,
        sourceCleanupIntentId: source.cleanupIntentId,
        tx,
        versionId,
        versionNumber,
        workspaceId,
      });
    },
    entityId: room.entityId,
    entityVersionId: versionId,
    fieldId,
    fileId: source.fileId,
    fileName: checkpointRoom.fileName,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    recordAuditEvent,
    scanWarnings: checkpointRoom.checkpointScanWarnings ?? undefined,
    sha256Hex: storedSha256Hex,
    sizeBytes: storedSizeBytes,
    source: COLLABORATION_DOCUMENT_SOURCE,
    tx,
    userId,
    versionMetadata: {
      collaborationContributorUserIds: contributorUserIds,
      ...(description !== undefined && { description }),
      ...(label !== undefined && { label }),
    },
    workspaceId,
    writePolicy: {
      type: "collaboration-room-publish",
      expectedCurrentVersionId: room.baseVersionId,
      filePropertyId: room.propertyId,
    },
  });
  if (versionWrite.status === "ok") {
    await requestNativeExtractionRun({ entityId: room.entityId, tx });
  }
  return publicationOutcome(versionWrite, room.entityId);
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
    captureError(error, { entityId: publication.entityId });
  });
  enqueuePdfDerivativeOrMarkFailed({
    encrypted: false,
    entityId: publication.entityId,
    fieldId: publication.fieldId,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    userId: brandPersistedUserId(userId),
    workspaceId,
  }).catch((error: unknown) => {
    captureError(error, {
      entityId: publication.entityId,
      fieldId: publication.fieldId,
    });
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
    captureError(error, { versionId: publication.versionId });
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
    body: publishFolioCollabVersionBodySchema,
    permissions: { entity: ["update"] },
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

    // The room's checkpoint can hold whatever a collaborator pasted in,
    // including a stamped download of this document. The published version
    // stores, and records, bytes without a reference.
    const { bytes: storedBytes, strippedArchive } =
      await storedDocumentBytes(checkpointBytes);
    const storedSha256Hex =
      strippedArchive === null
        ? body.expectedSha256Hex
        : new Bun.CryptoHasher("sha256").update(storedBytes).digest("hex");

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

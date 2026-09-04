import { panic, Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  entityVersions,
  folioCollabContributions,
  folioCollabPublications,
  folioCollabRooms,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
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
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { scanFile } from "@/api/lib/file-scan/scan";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
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

const publishFolioCollabVersion = createSafeHandler(
  {
    body: publishFolioCollabVersionBodySchema,
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "session_token_exchange" },
  } satisfies HandlerConfig,
  async function* ({
    body: {
      description,
      expectedGeneration,
      expectedSha256Hex,
      idempotencyKey,
      label,
      roomId,
    },
    recordAuditEvent,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const preliminary = yield* Result.await(
      safeDb(async (tx) => {
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
        const published = prior.at(0);
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
      }),
    );

    if (preliminary.status === "published") {
      return Result.ok({ ...preliminary, idempotent: true });
    }
    if (preliminary.status === "idempotency-conflict") {
      return Result.err(
        new HandlerError({
          code: "folio_collab_idempotency_key_reused",
          status: 409,
          message: "This publication key was already used for another room.",
        }),
      );
    }
    if (preliminary.status === "missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }
    if (
      !matchesFolioCollabCheckpointCut({
        checkpoint: preliminary.room,
        expectedFileId: preliminary.room.checkpointFileId,
        expectedGeneration,
        expectedSha256Hex,
      }) ||
      preliminary.room.checkpointSizeBytes === null
    ) {
      return Result.err(
        new HandlerError({
          code: "folio_collab_checkpoint_changed",
          status: 409,
          message: "Collaborative checkpoint changed. Create a new checkpoint.",
        }),
      );
    }

    const checkpointKey = createFileKey({
      fileId: preliminary.room.checkpointFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    const checkpoint = await readS3ArrayBuffer(checkpointKey, request.signal);
    const checkpointBytes = new Uint8Array(checkpoint);
    const actualSha256Hex = new Bun.CryptoHasher("sha256")
      .update(checkpointBytes)
      .digest("hex");
    if (actualSha256Hex !== expectedSha256Hex) {
      return Result.err(
        new HandlerError({
          code: "folio_collab_checkpoint_changed",
          status: 409,
          message:
            "Collaborative checkpoint bytes do not match its stored hash.",
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
      fileName: preliminary.room.fileName,
    });
    if (Result.isError(scanResult) || scanResult.value.verdict === "reject") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Collaborative checkpoint failed its publication scan.",
        }),
      );
    }

    const sourceFileId = allocateFileObject();
    const sourceKey = createFileKey({
      fileId: sourceFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    const sourceCleanupIntentId = yield* Result.await(
      reserveObjectCleanupIntent({
        objectKey: sourceKey,
        organizationId: session.activeOrganizationId,
        safeDb,
        workspaceId,
      }),
    );
    const cleanupSource = async (
      writeCertainty: S3ObjectWriteCertainty,
    ): Promise<void> => {
      const cleanup = await Result.tryPromise({
        try: async () =>
          await deleteS3ObjectWithSignal(
            sourceKey,
            AbortSignal.timeout(10_000),
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        captureError(cleanup.error, { roomId, storageKey: sourceKey });
      }
      const settlement = await settleObjectCleanupIntentsAfterWriter({
        intentIds: [sourceCleanupIntentId],
        objectState: objectWriterSettlementAfterCleanup({
          cleanupSucceeded: Result.isOk(cleanup),
          writeState: writeCertainty,
        }),
        safeDb,
      });
      if (Result.isError(settlement)) {
        captureError(settlement.error, { roomId, storageKey: sourceKey });
      }
    };
    const written = await Result.tryPromise({
      try: async () =>
        await writeS3ObjectWithRetry({
          contentType: DOCX_MIME_TYPE,
          data: checkpointBytes,
          key: sourceKey,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(written)) {
      await cleanupSource(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
      return Result.err(
        new HandlerError({
          cause: written.error,
          status: 500,
          message: "Failed to store the collaborative publication.",
        }),
      );
    }
    const writeCertainty = written.value;

    const publicationResult = await safeDb(async (tx) => {
      await lockActiveWorkspaceForBufferIntent(tx, workspaceId);
      await lockDocxEditTarget({
        entityId: preliminary.room.entityId,
        propertyId: preliminary.room.propertyId,
        tx,
        workspaceId,
      });
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
      const room = rooms.at(0);
      if (!room) {
        return { status: "missing" } as const;
      }

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
      const alreadyPublished = prior.at(0);
      if (alreadyPublished) {
        if (
          !matchesFolioCollabPublishedCut({
            expectedGeneration,
            expectedSha256Hex,
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
          expectedFileId: preliminary.room.checkpointFileId,
          expectedGeneration,
          expectedSha256Hex,
        })
      ) {
        return { status: "checkpoint-changed" } as const;
      }
      await lockObjectCleanupIntentsForWriter(tx, [sourceCleanupIntentId]);

      const contributorRows = await tx
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
      const contributorUserIds = contributorRows.map(
        (contributor) => contributor.userId,
      );
      const versionId = createSafeId<"entityVersion">();
      const fieldId = createSafeId<"field">();
      const nextCheckpointFileId = createSafeId<"userFile">();
      const versionWrite = await writeFileVersion({
        afterWrite: async ({ versionNumber }) => {
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
            Date.now() - FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS;
          const connectedContributorRows = contributorRows.filter(
            (contributor) =>
              contributor.updatedAt.getTime() > activeContributorCutoff,
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
            nextAttemptAt: new Date(Date.now() + CHECKPOINT_CLEANUP_GRACE_MS),
            objectKey: checkpointKey,
            organizationId: session.activeOrganizationId,
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
        },
        entityId: room.entityId,
        entityVersionId: versionId,
        fieldId,
        fileId: sourceFileId,
        fileName: preliminary.room.fileName,
        mimeType: DOCX_MIME_TYPE,
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
        scanWarnings: preliminary.room.checkpointScanWarnings ?? undefined,
        sha256Hex: expectedSha256Hex,
        sizeBytes: checkpointBytes.byteLength,
        source: COLLABORATION_DOCUMENT_SOURCE,
        tx,
        userId: user.id,
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
      switch (versionWrite.status) {
        case "ok":
          return {
            entityId: room.entityId,
            fieldId: versionWrite.fieldId,
            status: "created",
            versionId: versionWrite.entityVersionId,
            versionNumber: versionWrite.versionNumber,
          } as const;
        case "current-version-changed":
        case "current-version-not-found":
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
        default: {
          versionWrite satisfies never;
          return panic(`Unhandled version write: ${String(versionWrite)}`);
        }
      }
    });
    if (Result.isError(publicationResult)) {
      await cleanupSource(writeCertainty);
      if (isBufferIntentWorkspaceUnavailableError(publicationResult.error)) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "This document cannot be published right now.",
          }),
        );
      }
      if (isFolioCollabIdempotencyConstraintError(publicationResult.error)) {
        return Result.err(
          new HandlerError({
            code: "folio_collab_idempotency_key_reused",
            status: 409,
            message: "This publication key was already used.",
          }),
        );
      }
      return Result.err(publicationResult.error);
    }
    const publication = publicationResult.value;

    if (publication.status === "created") {
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
        organizationId: session.activeOrganizationId,
        userId: brandPersistedUserId(user.id),
        workspaceId,
      }).catch((error: unknown) => {
        captureError(error, {
          entityId: publication.entityId,
          fieldId: publication.fieldId,
        });
      });
      computeVersionDiffStats({
        entityId: publication.entityId,
        organizationId: session.activeOrganizationId,
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
      return Result.ok({
        idempotent: false,
        status: "published",
        versionId: publication.versionId,
        versionNumber: publication.versionNumber,
      });
    }

    await cleanupSource(writeCertainty);
    if (publication.status === "idempotent") {
      return Result.ok({
        idempotent: true,
        status: "published",
        versionId: publication.versionId,
        versionNumber: publication.versionNumber,
      });
    }
    if (publication.status === "base-drift") {
      return Result.err(
        new HandlerError({
          code: "folio_collab_base_version_changed",
          status: 409,
          message:
            "A newer document version exists. The collaboration checkpoint was retained.",
        }),
      );
    }
    if (publication.status === "checkpoint-changed") {
      return Result.err(
        new HandlerError({
          code: "folio_collab_checkpoint_changed",
          status: 409,
          message: "Collaborative checkpoint changed. Create a new checkpoint.",
        }),
      );
    }
    if (publication.status === "idempotency-conflict") {
      return Result.err(
        new HandlerError({
          code: "folio_collab_idempotency_key_reused",
          status: 409,
          message: "This publication key was already used for another room.",
        }),
      );
    }
    if (publication.status === "read-only") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This document is read-only and cannot be published.",
        }),
      );
    }
    if (publication.status === "unavailable") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This document cannot be published right now.",
        }),
      );
    }
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Collaborative editing room not found.",
      }),
    );
  },
);

export default publishFolioCollabVersion;

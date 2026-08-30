import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { materializeYjsDocx } from "@stll/folio-core/server";

import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  folioCollabRooms,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockActiveWorkspaceForBufferIntent,
  lockObjectCleanupIntentsForWriter,
  reserveObjectCleanupIntent,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  presignDocxDownloadFromFileId,
  readVersionDocxTarget,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { validateDesktopEditFileBuffer } from "@/api/lib/entity-versions/validate-desktop-edit-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import {
  FOLIO_COLLAB_CHECKPOINT_MAX_BYTES,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
} from "@/api/lib/folio-collab-room-contract";
import {
  deleteS3ObjectWithSignal,
  readS3ArrayBuffer,
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CHECKPOINT_CLEANUP_GRACE_MS = 60_000;

const checkpointFolioCollabRoomBodySchema = t.Object({
  expectedGeneration: t.Integer({ minimum: 0 }),
  expectedSnapshotRevision: t.Integer({ minimum: 0 }),
  roomId: tSafeId("folioCollabRoom"),
});

type CheckpointFolioCollabRoomBody = Static<
  typeof checkpointFolioCollabRoomBodySchema
>;

type FolioCollabSnapshotCut = {
  baseVersionId: SafeId<"entityVersion">;
  generation: number;
  snapshotFileId: SafeId<"userFile">;
  snapshotRevision: number;
  snapshotUpdatedAt: Date | null;
};

export const matchesFolioCollabSnapshotCut = ({
  current,
  materialized,
}: {
  current: FolioCollabSnapshotCut;
  materialized: FolioCollabSnapshotCut;
}) =>
  current.baseVersionId === materialized.baseVersionId &&
  current.generation === materialized.generation &&
  current.snapshotFileId === materialized.snapshotFileId &&
  current.snapshotRevision === materialized.snapshotRevision &&
  current.snapshotUpdatedAt?.getTime() ===
    materialized.snapshotUpdatedAt?.getTime();

const checkpointFolioCollabRoom = createSafeHandler(
  {
    body: checkpointFolioCollabRoomBodySchema,
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "session_token_exchange" },
  } satisfies HandlerConfig,
  async function* ({
    body: { expectedGeneration, expectedSnapshotRevision, roomId },
    recordAuditEvent,
    request,
    safeDb,
    session,
    workspaceId,
  }) {
    const target = yield* Result.await(
      safeDb(async (tx) => {
        const rooms = await tx
          .select({
            baseVersionId: folioCollabRooms.baseVersionId,
            entityId: folioCollabRooms.entityId,
            fileName: folioCollabRooms.fileName,
            generation: folioCollabRooms.generation,
            propertyId: folioCollabRooms.propertyId,
            seedState: folioCollabRooms.seedState,
            snapshotFileId: folioCollabRooms.yjsSnapshotFileId,
            snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
            snapshotSizeBytes: folioCollabRooms.yjsSnapshotSizeBytes,
            snapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
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
        if (!room) {
          return null;
        }
        const sourceFile = await readVersionDocxTarget({
          entityVersionId: room.baseVersionId,
          propertyId: room.propertyId,
          tx,
          workspaceId,
        });
        return { room, sourceFile };
      }),
    );

    if (!target) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }
    if (target.room.generation !== expectedGeneration) {
      return Result.err(
        new HandlerError({
          code: "folio_collab_generation_changed",
          status: 409,
          message: "Collaborative room generation changed.",
        }),
      );
    }
    if (target.room.snapshotRevision !== expectedSnapshotRevision) {
      return Result.err(
        new HandlerError({
          code: "folio_collab_snapshot_revision_changed",
          status: 428,
          message: "Collaborative snapshot revision changed.",
        }),
      );
    }
    if (
      target.room.seedState !== "seeded" ||
      target.room.snapshotUpdatedAt === null ||
      target.room.snapshotSizeBytes === null
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Collaborative room has no durable document snapshot.",
        }),
      );
    }
    if (!target.sourceFile) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Collaborative room source file is no longer available.",
        }),
      );
    }
    if (target.room.snapshotSizeBytes > FOLIO_COLLAB_SNAPSHOT_MAX_BYTES) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Collaborative snapshot is too large.",
        }),
      );
    }

    const sourceKey = createFileKey({
      fileId: target.sourceFile.id,
      mimeType: DOCX_MIME_TYPE,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    const snapshotKey = createFileKey({
      fileId: target.room.snapshotFileId,
      mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    const [sourceDocx, yjsUpdate] = await Promise.all([
      readS3ArrayBuffer(sourceKey, request.signal),
      readS3ArrayBuffer(snapshotKey, request.signal),
    ]);
    const materialized = await materializeYjsDocx({
      sourceDocx,
      yjsUpdate: new Uint8Array(yjsUpdate),
    });
    if (materialized.byteLength > FOLIO_COLLAB_CHECKPOINT_MAX_BYTES) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Materialized collaboration checkpoint is too large.",
        }),
      );
    }

    const validation = await validateDesktopEditFileBuffer({
      buffer: materialized,
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
      buffer: new Uint8Array(materialized),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: target.room.fileName,
    });
    if (Result.isError(scanResult)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "File security scan failed.",
        }),
      );
    }
    if (scanResult.value.verdict === "reject") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "File security scan rejected the checkpoint.",
        }),
      );
    }
    const scanWarnings =
      scanResult.value.verdict === "warn"
        ? scanResult.value.findings
            .filter(({ severity }) => severity === "warn")
            .map(({ message }) => message)
        : null;
    const checkpointBytes = new Uint8Array(materialized);
    const sha256Hex = new Bun.CryptoHasher("sha256")
      .update(checkpointBytes)
      .digest("hex");
    const nextFileId = createSafeId<"userFile">();
    const checkpointKey = createFileKey({
      fileId: nextFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    const cleanupIntentId = yield* Result.await(
      reserveObjectCleanupIntent({
        objectKey: checkpointKey,
        organizationId: session.activeOrganizationId,
        safeDb,
        workspaceId,
      }),
    );
    const discardCheckpoint = async (
      writeCertainty: S3ObjectWriteCertainty,
    ): Promise<void> => {
      const cleanup = await Result.tryPromise({
        try: async () =>
          await deleteS3ObjectWithSignal(
            checkpointKey,
            AbortSignal.timeout(10_000),
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanup)) {
        captureError(cleanup.error, { roomId, storageKey: checkpointKey });
      }
      const settlement = await settleObjectCleanupIntentsAfterWriter({
        intentIds: [cleanupIntentId],
        objectState:
          writeCertainty === S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN
            ? "write-uncertain"
            : Result.isOk(cleanup)
              ? "object-deleted"
              : "cleanup-required",
        safeDb,
      });
      if (Result.isError(settlement)) {
        captureError(settlement.error, {
          roomId,
          storageKey: checkpointKey,
        });
      }
    };
    const written = await Result.tryPromise({
      try: async () =>
        await writeS3ObjectWithRetry({
          contentType: DOCX_MIME_TYPE,
          data: checkpointBytes,
          key: checkpointKey,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(written)) {
      await discardCheckpoint(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
      throw written.error;
    }
    const writeCertainty = written.value;

    const checkpointedAt = new Date();
    const storedResult = await safeDb(async (tx) => {
      await lockActiveWorkspaceForBufferIntent(tx, workspaceId);
      const rooms = await tx
        .select({
          baseVersionId: folioCollabRooms.baseVersionId,
          checkpointFileId: folioCollabRooms.docxCheckpointFileId,
          checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
          checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
          generation: folioCollabRooms.generation,
          snapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
          snapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
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
      if (
        !room ||
        !matchesFolioCollabSnapshotCut({
          current: room,
          materialized: target.room,
        })
      ) {
        return false;
      }
      await lockObjectCleanupIntentsForWriter(tx, [cleanupIntentId]);

      await tx
        .update(folioCollabRooms)
        .set({
          docxCheckpointFileId: nextFileId,
          docxCheckpointScanWarnings: scanWarnings,
          docxCheckpointSha256Hex: sha256Hex,
          docxCheckpointSizeBytes: checkpointBytes.byteLength,
          docxCheckpointUpdatedAt: checkpointedAt,
        })
        .where(
          and(
            eq(folioCollabRooms.id, roomId),
            eq(folioCollabRooms.workspaceId, workspaceId),
            eq(folioCollabRooms.generation, expectedGeneration),
            eq(folioCollabRooms.yjsSnapshotRevision, expectedSnapshotRevision),
          ),
        );
      if (room.checkpointUpdatedAt !== null) {
        await tx.insert(bufferObjectCleanupIntents).values({
          id: createSafeId<"pendingUpload">(),
          nextAttemptAt: new Date(Date.now() + CHECKPOINT_CLEANUP_GRACE_MS),
          objectKey: createFileKey({
            fileId: room.checkpointFileId,
            mimeType: DOCX_MIME_TYPE,
            organizationId: session.activeOrganizationId,
            workspaceId,
          }),
          organizationId: session.activeOrganizationId,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
          workspaceId,
        });
      }
      await tx
        .delete(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.id, cleanupIntentId));
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
        resourceId: roomId,
        changes: {
          checkpointSha256Hex: {
            old: room.checkpointSha256Hex,
            new: sha256Hex,
          },
        },
      });
      return true;
    });
    if (Result.isError(storedResult)) {
      await discardCheckpoint(writeCertainty);
      return Result.err(storedResult.error);
    }
    const stored = storedResult.value;

    if (!stored) {
      await discardCheckpoint(writeCertainty);
      return Result.err(
        new HandlerError({
          code: "folio_collab_checkpoint_changed",
          status: 409,
          message:
            "Collaborative document changed while its checkpoint was created.",
        }),
      );
    }

    const downloadUrl = await presignDocxDownloadFromFileId({
      fileId: nextFileId,
      fileName: target.room.fileName,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
    return Result.ok({
      checkpointedAt: checkpointedAt.toISOString(),
      downloadUrl,
      generation: expectedGeneration,
      sha256Hex,
    });
  },
);

export default checkpointFolioCollabRoom;
export type { CheckpointFolioCollabRoomBody };
